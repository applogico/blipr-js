import { BliprError } from './errors';
import { safeText, serverReason, sleep, validateTopic } from './internal';
import type { NotifyMessage, SubscribeOptions } from './types';

const MAX_BACKOFF_MS = 30_000;
const FILTER_KEYS = ['message', 'title', 'priority', 'tags'] as const;

function validateTopicList(topic: string): void {
  for (const part of topic.split(',')) validateTopic(part.trim());
}

function streamUrl(
  server: string,
  topic: string,
  since: string | undefined,
  opts: SubscribeOptions,
): string {
  const url = new URL(`${server}/blip/${topic}/sse`);
  if (since != null) url.searchParams.set('since', since);
  if (opts.poll) url.searchParams.set('poll', '1');
  for (const key of FILTER_KEYS) {
    const value = opts.filter?.[key];
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

async function openStream(
  fetchImpl: typeof fetch,
  url: string,
  topic: string,
  opts: SubscribeOptions,
  clientToken: string | undefined,
  signal: AbortSignal,
): Promise<ReadableStream<Uint8Array>> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  const token = opts.token ?? clientToken;
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok || !res.body) {
    const body = await safeText(res);
    const reason = serverReason(body);
    throw new BliprError(
      `Subscribe to "${topic}" failed (HTTP ${res.status})${reason ? `: ${reason}` : '.'}`,
      { status: res.status, body },
    );
  }
  return res.body;
}

async function* readMessages(
  body: ReadableStream<Uint8Array>,
  onId: (id: string) => void,
): AsyncGenerator<NotifyMessage> {
  for await (const frame of parseSse(body)) {
    const event = frame.event;
    if (event === 'open' || event === 'keepalive') continue;
    const id = frame.id;
    if (typeof id === 'string' || typeof id === 'number') onId(String(id));
    yield frame as NotifyMessage;
  }
}

/**
 * Yield messages for a topic, reconnecting with backoff until `signal` aborts.
 * On reconnect it resumes from the last seen message id, so drops don't lose
 * messages. `topic` may be a comma-separated list.
 */
export async function* streamMessages(
  fetchImpl: typeof fetch,
  server: string,
  topic: string,
  opts: SubscribeOptions,
  clientToken: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<NotifyMessage> {
  validateTopicList(topic);

  let since = opts.since;
  let attempt = 0;

  // Read through a call: `signal.aborted` flips under us, so narrowing it would be wrong.
  const aborted = () => signal.aborted;
  const setSince = (id: string) => {
    since = id;
  };

  while (!aborted()) {
    try {
      const url = streamUrl(server, topic, since, opts);
      const body = await openStream(fetchImpl, url, topic, opts, clientToken, signal);
      attempt = 0;
      opts.onOpen?.();
      yield* readMessages(body, setSince);
    } catch (err) {
      if (aborted()) return;
      opts.onError?.(err);
    }

    // A clean end (poll finished, or server closed) or an error: stop if we're
    // one-shot or aborted, otherwise back off and reconnect.
    if (opts.poll || aborted()) return;
    await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++), signal);
  }
}

/** Parse an SSE byte stream into JSON `data:` payloads. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frameData(frame);
        if (data == null) continue;
        try {
          yield JSON.parse(data) as Record<string, unknown>;
        } catch {
          // ignore malformed frame
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // stream already closed
    }
  }
}

/** Extract and join the `data:` lines from one SSE frame. */
function frameData(frame: string): string | null {
  const data: string[] = [];
  for (const raw of frame.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('data:')) {
      data.push(line.slice(5).replace(/^ /, ''));
    }
    // ":" comments, "event:", "id:" etc. are ignored — payloads are JSON.
  }
  return data.length ? data.join('\n') : null;
}
