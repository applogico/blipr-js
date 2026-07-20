import { BliprError } from './errors';
import { sleep, validateTopic } from './internal';
import type { NotifyMessage, SubscribeOptions } from './types';

const MAX_BACKOFF_MS = 30_000;

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
  for (const part of topic.split(',')) validateTopic(part.trim());

  let since = opts.since;
  let attempt = 0;

  while (!signal.aborted) {
    const url = new URL(`${server}/blip/${topic}/sse`);
    if (since != null) url.searchParams.set('since', since);
    if (opts.poll) url.searchParams.set('poll', '1');
    if (opts.filter?.message) url.searchParams.set('message', opts.filter.message);
    if (opts.filter?.title) url.searchParams.set('title', opts.filter.title);
    if (opts.filter?.priority) url.searchParams.set('priority', opts.filter.priority);
    if (opts.filter?.tags) url.searchParams.set('tags', opts.filter.tags);

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    const token = opts.token ?? clientToken;
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetchImpl(url.toString(), { headers, signal });
      if (!res.ok || !res.body) {
        throw new BliprError(`Subscribe to "${topic}" failed (HTTP ${res.status}).`, {
          status: res.status,
        });
      }
      attempt = 0;
      opts.onOpen?.();

      for await (const frame of parseSse(res.body)) {
        const event = (frame as { event?: string }).event;
        if (event === 'open' || event === 'keepalive') continue;
        const msg = frame as NotifyMessage;
        if (msg.id != null) since = String(msg.id);
        yield msg;
      }
    } catch (err) {
      if (signal.aborted) return;
      opts.onError?.(err);
    }

    // A clean end (poll finished, or server closed) or an error: stop if we're
    // one-shot or aborted, otherwise back off and reconnect.
    if (opts.poll || signal.aborted) return;
    await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt++), signal);
  }
}

/** Parse an SSE byte stream into JSON `data:` payloads. */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
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
          yield JSON.parse(data);
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
