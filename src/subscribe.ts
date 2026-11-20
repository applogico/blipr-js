import { BliprError } from './errors';
import { isProtectedTopic, safeText, serverReason, sleep, validateTopic } from './internal';
import type { NotifyMessage, SubscribeOptions } from './types';

const MAX_BACKOFF_MS = 30_000;
const FILTER_KEYS = ['message', 'title', 'priority', 'tags'] as const;

/** Validate each entry of a comma-separated list and rebuild it from the parts. */
function normalizeTopicList(topic: string): string {
  const parts = topic.split(',').map((part) => validateTopic(part.trim()));
  // The server only takes comma lists of public topics; a protected one streams alone.
  if (parts.length > 1 && parts.some(isProtectedTopic)) {
    throw new BliprError(
      `Subscribe to "${topic}" failed: a protected topic can't be in a list. Subscribe to it on its own.`,
    );
  }
  return parts.join(',');
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

/** How many delivered message ids to remember for skipping replayed copies. */
const SEEN_LIMIT = 1_000;

/** The `since` that replays everything after `m`, or undefined if `m` carries no position. */
function resumeFrom(m: Record<string, unknown>): string | undefined {
  const { cursor, time } = m;
  if (typeof cursor === 'number' && Number.isInteger(cursor)) return `c${cursor}`;
  if (typeof cursor === 'string' && /^\d+$/.test(cursor)) return `c${cursor}`;
  // Older servers without cursors: the time form is inclusive, so the dedupe below drops the overlap.
  if (typeof time === 'number' && Number.isInteger(time)) return String(time);
  return undefined;
}

/** Tracks where to resume and which messages already reached the caller. */
class ResumePoint {
  private readonly seen = new Set<string>();

  constructor(public since: string | undefined) {}

  /** Record a message; false when it was already delivered. */
  accept(m: Record<string, unknown>): boolean {
    const id = typeof m.id === 'string' || typeof m.id === 'number' ? String(m.id) : undefined;
    if (id != null) {
      if (this.seen.has(id)) return false;
      this.seen.add(id);
      if (this.seen.size > SEEN_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    }
    this.since = resumeFrom(m) ?? this.since;
    return true;
  }
}

async function* readMessages(
  body: ReadableStream<Uint8Array>,
  resume: ResumePoint,
): AsyncGenerator<NotifyMessage> {
  for await (const frame of parseSse(body)) {
    const event = frame.event;
    if (event === 'open' || event === 'keepalive') continue;
    if (!resume.accept(frame)) continue;
    yield frame as NotifyMessage;
  }
}

/**
 * Yield messages for a topic, reconnecting with backoff until `signal` aborts.
 * On reconnect it resumes after the last received message's `cursor`, so drops
 * don't lose messages, and skips any replayed message it already delivered.
 * `topic` may be a comma-separated list of public topics, with or without
 * spaces around the entries, or a single protected `@handle/topic`.
 */
export async function* streamMessages(
  fetchImpl: typeof fetch,
  server: string,
  topic: string,
  opts: SubscribeOptions,
  clientToken: string | undefined,
  signal: AbortSignal,
): AsyncGenerator<NotifyMessage> {
  // Everything below uses the normalised list: sending back the caller's
  // spacing would make it part of the topic name the server matches on.
  const topics = normalizeTopicList(topic);

  const resume = new ResumePoint(opts.since);
  let attempt = 0;

  // Read through a call: `signal.aborted` flips under us, so narrowing it would be wrong.
  const aborted = () => signal.aborted;

  while (!aborted()) {
    try {
      const url = streamUrl(server, topics, resume.since, opts);
      const body = await openStream(fetchImpl, url, topics, opts, clientToken, signal);
      attempt = 0;
      opts.onOpen?.();
      yield* readMessages(body, resume);
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
