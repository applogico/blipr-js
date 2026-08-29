import { BliprError } from './errors';

/** Server topic rule (`notify::domain::topic::validate_name`). */
const LEAF_RE = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * Server handle rule (`users::domain::handle::is_valid`): lowercase letters,
 * digits and `_`, 3–30 chars, no leading digit. Its reserved-name list is
 * deliberately not copied here — that is claim-time policy, and a stale copy
 * would reject a name the server had since freed.
 */
const HANDLE_RE = /^[a-z_][a-z0-9_]{2,29}$/;
const LEAF_HELP = 'use letters, digits, - and _, max 64 chars';

/** Split `@handle/leaf` into its two halves; `null` for a bare public topic. */
function protectedParts(topic: string): { handle: string; leaf: string } | null {
  const match = /^@([^/]*)\/(.*)$/.exec(topic);
  if (!match) return null;
  return { handle: match[1], leaf: match[2] };
}

/**
 * Validate a topic against the server's rule: either a bare public topic, or
 * the protected address `@{handle}/{leaf}`.
 */
export function validateTopic(topic: string): string {
  const owned = protectedParts(topic);
  if (owned) {
    if (!HANDLE_RE.test(owned.handle)) {
      throw new BliprError(
        `Invalid handle in topic "${topic}": a handle is 3–30 lowercase letters, digits and _, not starting with a digit.`,
      );
    }
    if (!LEAF_RE.test(owned.leaf)) {
      throw new BliprError(`Invalid topic "${topic}": after the handle, ${LEAF_HELP}.`);
    }
    return topic;
  }
  if (!LEAF_RE.test(topic)) {
    throw new BliprError(`Invalid topic "${topic}": ${LEAF_HELP}, or @handle/topic.`);
  }
  return topic;
}

/** Encode a topic for a URL path — `@handle/leaf` is two segments, not one. */
export function topicPath(topic: string): string {
  return topic.split('/').map(encodeURIComponent).join('/');
}

/** Strip trailing slashes from a base URL. */
export function trimServer(server: string): string {
  return server.replace(/\/+$/, '');
}

/** Resolve a fetch implementation, preferring an explicit one. */
export function getFetch(custom?: typeof fetch): typeof fetch {
  // The DOM lib types `fetch` as always present; on older runtimes it isn't.
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  const f = custom ?? globalFetch;
  if (!f) {
    throw new BliprError(
      'No global fetch found. Use Node >= 18, a modern browser/edge runtime, or pass { fetch }.',
    );
  }
  return f;
}

/** Join a string | string[] into a comma-separated value. */
export function csv(value?: string | string[]): string | undefined {
  if (value == null) return undefined;
  return Array.isArray(value) ? value.join(',') : value;
}

/** Sleep for `ms`, resolving early if the signal aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** Combine an internal signal with an optional user signal (either aborts). */
export function mergeSignals(internal: AbortSignal, user?: AbortSignal): AbortSignal {
  if (!user) return internal;
  const ctrl = new AbortController();
  const abort = () => {
    ctrl.abort();
  };
  if (internal.aborted || user.aborted) {
    ctrl.abort();
  } else {
    internal.addEventListener('abort', abort, { once: true });
    user.addEventListener('abort', abort, { once: true });
  }
  return ctrl.signal;
}

/** The server's `error` field, when the body is JSON carrying one. */
export function serverReason(body: string): string | undefined {
  try {
    const { error } = JSON.parse(body) as { error?: unknown };
    return typeof error === 'string' && error !== '' ? error : undefined;
  } catch {
    return undefined;
  }
}

export async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}
