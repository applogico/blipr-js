import { BliprError } from './errors';

/** Server topic rule: letters, digits, `-` and `_`, 1–64 chars. */
const TOPIC_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Server handle rule: 3–30 letters, digits and `_`, no leading digit; matched case-insensitively. */
const HANDLE_RE = /^[A-Za-z_][A-Za-z0-9_]{2,29}$/;

/** Whether `topic` is a protected `@handle/topic` address (by its leading sigil). */
export function isProtectedTopic(topic: string): boolean {
  return topic.startsWith('@');
}

/** Validate a single public `topic` or protected `@handle/topic` against the server's rules. */
export function validateTopic(topic: string): string {
  if (isProtectedTopic(topic)) {
    const slash = topic.indexOf('/');
    const handle = topic.slice(1, slash);
    const leaf = topic.slice(slash + 1);
    if (slash === -1 || !HANDLE_RE.test(handle) || !TOPIC_RE.test(leaf)) {
      throw new BliprError(
        `Invalid protected topic "${topic}": use @handle/topic, with a handle of 3 to 30 letters, digits and _ that does not start with a digit, and a topic of letters, digits, - and _, max 64 chars.`,
      );
    }
    return topic;
  }
  if (!TOPIC_RE.test(topic)) {
    throw new BliprError(
      `Invalid topic "${topic}": use letters, digits, - and _, max 64 chars, or @handle/topic for a protected topic.`,
    );
  }
  return topic;
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
