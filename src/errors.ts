/** Error thrown for a failed publish/subscribe (HTTP or network). */
export class BliprError extends Error {
  /** HTTP status, when the server responded with a non-2xx. */
  readonly status?: number;
  /** Response body (truncated), when available. */
  readonly body?: string;

  constructor(
    message: string,
    opts: { status?: number; body?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'BliprError';
    this.status = opts.status;
    this.body = opts.body;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}
