/** Priority: 1–5, or a named level the server also understands. */
export type Priority =
  | 1 | 2 | 3 | 4 | 5
  | 'min' | 'low' | 'default' | 'high' | 'max' | 'urgent';

/** Ask the recipient for a reply. Omit for a one-way message. */
export type ExpectedReply = 'binary' | 'ack' | 'choice' | 'text';

/** Options for a single publish. */
export interface PublishOptions {
  /** Notification title. */
  title?: string;
  /** 1–5, or a named level. 5 arrives Time-Sensitive (breaks through Focus/DND). */
  priority?: Priority;
  /** Tags / emoji shortcodes, e.g. `['rocket', 'white_check_mark']` or `"rocket,warning"`. */
  tags?: string | string[];
  /** URL to open when the notification is tapped. */
  click?: string;
  /** URL of an icon image to show. */
  icon?: string;
  /** Render the body as Markdown. */
  markdown?: boolean;
  /** Ask for a reply: `binary` | `ack` | `choice` | `text` (a typed answer, up to 120 characters). */
  reply?: ExpectedReply;
  /** Choices (2–5) when `reply` is `choice`. */
  options?: string | string[];
  /** URL the reply is POSTed to when it lands. */
  callback?: string;
  /** Publish token for a protected topic. Overrides the client-level token. */
  token?: string;
  /** Abort the request. */
  signal?: AbortSignal;
}

/** A message as returned by the notify server. */
export interface NotifyMessage {
  /** Server-assigned message id. */
  id: string;
  /** Topic the message was published to. */
  topic: string;
  /** Message body. */
  message?: string;
  /** Title, if any. */
  title?: string;
  /** Resolved priority (1–5). */
  priority?: number;
  /** Tags / emoji shortcodes. */
  tags?: string[];
  /** Unix seconds the message was created. */
  time?: number;
  /** Server position of the message; `since: "c<cursor>"` resumes after it. */
  cursor?: number;
  /** Click-through URL. */
  click?: string;
  /** Whether the publisher was validated (protected topics). */
  verified?: boolean;
  /** Reply the publisher asked for, if any. */
  expected_reply?: ExpectedReply;
  /** Choices to pick from when `expected_reply` is `choice`. */
  options?: string[];
  /** Any other fields the server sends. */
  [key: string]: unknown;
}

/** Server-side filters, applied to the stream by the server. */
export interface SubscribeFilter {
  message?: string;
  title?: string;
  /** Comma-separated priorities, e.g. `"4,5"`. */
  priority?: string;
  /** Comma-separated tags. */
  tags?: string;
}

/** Options for a subscription. */
export interface SubscribeOptions {
  /**
   * Where to start: `"all"`, `"c<cursor>"` (after a received message's
   * `cursor`), a Unix timestamp in seconds, or a duration like `"10m"`.
   * Omit it to get only new messages. On reconnect the client resumes after
   * the last message it received.
   */
  since?: string;
  /**
   * One-shot: return the backlog, then close instead of streaming live.
   * Pair it with `since` (e.g. `"all"`); without one there is no backlog.
   */
  poll?: boolean;
  /** Server-side filters. */
  filter?: SubscribeFilter;
  /** Token for a protected topic. Overrides the client-level token. */
  token?: string;
  /** Abort the subscription. */
  signal?: AbortSignal;
  /** Called each time the stream (re)connects. */
  onOpen?: () => void;
  /** Called on a connection error before the client retries. */
  onError?: (error: unknown) => void;
}

/** An answer to a question. */
export interface Reply {
  /** `yes` / `no`, `ack`, the chosen option, or the typed text. */
  value: string;
  /** When the answer was given, in Unix seconds. */
  replied_at: number;
}

/** Options for waiting on an answer. */
export interface WaitForReplyOptions {
  /** Token for a protected topic. Overrides the client-level token. */
  token?: string;
  /** Stop waiting. */
  signal?: AbortSignal;
}

/** A live subscription handle. */
export interface Subscription {
  /** Stop the subscription and close the connection. */
  close(): void;
  /** Resolves when the subscription ends (poll finished, or closed). */
  readonly done: Promise<void>;
}

/** Client configuration. */
export interface BliprClientOptions {
  /** Base URL of the Blipr / notify server. Default `https://blipr.dev`. */
  server?: string;
  /** Publish/subscribe token, used when a per-call token isn't given. */
  token?: string;
  /** Custom fetch implementation (defaults to global `fetch`). */
  fetch?: typeof fetch;
}
