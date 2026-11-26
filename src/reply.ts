import { BliprError } from './errors';
import { safeText, serverReason, sleep, validateTopic } from './internal';
import { openStream, parseSse } from './subscribe';
import type { Reply, WaitForReplyOptions } from './types';

const MAX_BACKOFF_MS = 30_000;
/** Longest wait the reply endpoint accepts in one request. */
const LONG_POLL_SECONDS = 300;

/** A refusal the server will repeat on every retry (bad topic, no access, unknown message). */
function isRefusal(err: unknown): boolean {
  const status = err instanceof BliprError ? err.status : undefined;
  return status !== undefined && status >= 400 && status < 500 && status !== 429;
}

/** One request to the reply endpoint; undefined while there is no answer. */
async function readReply(
  fetchImpl: typeof fetch,
  url: string,
  topic: string,
  token: string | undefined,
  waitSeconds: number,
  signal: AbortSignal,
): Promise<Reply | undefined> {
  const headers: Record<string, string> = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetchImpl(`${url}?wait=${waitSeconds}`, { headers, signal });
  if (!res.ok) {
    const body = await safeText(res);
    const reason = serverReason(body);
    throw new BliprError(
      `Reading the reply on "${topic}" failed (HTTP ${res.status})${reason ? `: ${reason}` : '.'}`,
      { status: res.status, body },
    );
  }
  const state = (await res.json()) as { status?: string; value?: unknown; replied_at?: unknown };
  if (state.status !== 'answered' || typeof state.value !== 'string') return undefined;
  return { value: state.value, replied_at: typeof state.replied_at === 'number' ? state.replied_at : 0 };
}

/** The answer a stream frame carries for `messageId`, if it is one. */
function replyIn(frame: Record<string, unknown>, messageId: string): Reply | undefined {
  if (frame.event !== 'reply' || frame.message_id !== messageId) return undefined;
  if (typeof frame.value !== 'string') return undefined;
  return { value: frame.value, replied_at: typeof frame.replied_at === 'number' ? frame.replied_at : 0 };
}

/** What one wait needs on every request. */
interface Wait {
  fetchImpl: typeof fetch;
  topic: string;
  messageId: string;
  token: string | undefined;
  signal: AbortSignal;
  replyUrl: string;
  streamUrl: string;
}

/**
 * The answer as of a (re)connect: one given before the stream opened, or, on a
 * server that does not send answers on the stream, whatever the reply endpoint
 * reports until one arrives.
 */
async function replyOnOpen(w: Wait, streamed: boolean): Promise<Reply | undefined> {
  let stored = await readReply(w.fetchImpl, w.replyUrl, w.topic, w.token, 0, w.signal);
  while (!stored && !streamed && !w.signal.aborted) {
    stored = await readReply(w.fetchImpl, w.replyUrl, w.topic, w.token, LONG_POLL_SECONDS, w.signal);
  }
  return stored;
}

/** The answer a frame leads to, if any. */
function replyFor(w: Wait, frame: Record<string, unknown>): Promise<Reply | undefined> {
  if (frame.event === 'open') return replyOnOpen(w, frame.replies === true);
  // Each keepalive re-reads the stored answer, in case its stream event was lost on the way.
  if (frame.event === 'keepalive') {
    return readReply(w.fetchImpl, w.replyUrl, w.topic, w.token, 0, w.signal);
  }
  return Promise.resolve(replyIn(frame, w.messageId));
}

/** Read one connection until the answer arrives; undefined when the stream ends first. */
async function replyFromStream(w: Wait): Promise<Reply | undefined> {
  const body = await openStream(w.fetchImpl, w.streamUrl, w.topic, { token: w.token }, undefined, w.signal);
  for await (const frame of parseSse(body)) {
    const reply = await replyFor(w, frame);
    if (reply) return reply;
  }
  return undefined;
}

/**
 * Wait for the answer to a question on the topic's event stream. Resolves with
 * `undefined` when `signal` aborts first.
 */
export async function waitForReply(
  fetchImpl: typeof fetch,
  server: string,
  topic: string,
  messageId: string,
  opts: WaitForReplyOptions,
  clientToken: string | undefined,
): Promise<Reply | undefined> {
  validateTopic(topic);
  const signal = opts.signal ?? new AbortController().signal;
  const w: Wait = {
    fetchImpl,
    topic,
    messageId,
    token: opts.token ?? clientToken,
    signal,
    replyUrl: `${server}/blip/${topic}/${encodeURIComponent(messageId)}/reply`,
    streamUrl: `${server}/blip/${topic}/sse?replies=1`,
  };
  // Read through a call: `signal.aborted` flips under us, so narrowing it would be wrong.
  const aborted = () => signal.aborted;

  for (let attempt = 0; !aborted(); attempt++) {
    try {
      const reply = await replyFromStream(w);
      if (reply) return reply;
      attempt = 0;
    } catch (err) {
      if (!aborted() && isRefusal(err)) throw err;
    }
    await sleep(Math.min(MAX_BACKOFF_MS, 500 * 2 ** attempt), signal);
  }
  return undefined;
}
