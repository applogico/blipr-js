import { getFetch, mergeSignals, trimServer } from './internal';
import { publish } from './publish';
import { streamMessages } from './subscribe';
import type {
  BliprClientOptions,
  NotifyMessage,
  PublishOptions,
  SubscribeOptions,
  Subscription,
} from './types';

const DEFAULT_SERVER = 'https://blipr.dev';

/**
 * A Blipr client — publish and subscribe to notification topics.
 *
 * ```ts
 * const blipr = new BliprClient();
 * await blipr.publish('deploys', 'Shipped 🚀', { priority: 4, tags: 'rocket' });
 * const sub = blipr.subscribe('deploys', (m) => console.log(m.message));
 * ```
 */
export class BliprClient {
  /** Base URL this client publishes/subscribes against. */
  readonly server: string;
  private readonly token?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: BliprClientOptions = {}) {
    this.server = trimServer(options.server ?? DEFAULT_SERVER);
    this.token = options.token;
    this.fetchImpl = getFetch(options.fetch);
  }

  /** Publish a message to a topic. Resolves with the stored message. */
  publish(
    topic: string,
    message: string,
    options: PublishOptions = {},
  ): Promise<NotifyMessage> {
    return publish(this.fetchImpl, this.server, topic, message, options, this.token);
  }

  /**
   * Subscribe to a topic, calling `onMessage` for each message. Reconnects
   * automatically. Call `.close()` on the returned handle to stop.
   */
  subscribe(
    topic: string,
    onMessage: (message: NotifyMessage) => void,
    options: SubscribeOptions = {},
  ): Subscription {
    const controller = new AbortController();
    const signal = mergeSignals(controller.signal, options.signal);
    const done = (async () => {
      for await (const message of streamMessages(
        this.fetchImpl,
        this.server,
        topic,
        options,
        this.token,
        signal,
      )) {
        try {
          onMessage(message);
        } catch (err) {
          options.onError?.(err);
        }
      }
    })();
    return {
      close: () => controller.abort(),
      done: done.catch(() => {}),
    };
  }

  /**
   * Subscribe to a topic as an async iterable. Breaking out of the loop (or
   * `.return()`) closes the connection.
   *
   * ```ts
   * for await (const m of blipr.messages('deploys')) console.log(m.message);
   * ```
   */
  async *messages(
    topic: string,
    options: SubscribeOptions = {},
  ): AsyncGenerator<NotifyMessage> {
    const controller = new AbortController();
    const signal = mergeSignals(controller.signal, options.signal);
    try {
      yield* streamMessages(
        this.fetchImpl,
        this.server,
        topic,
        options,
        this.token,
        signal,
      );
    } finally {
      controller.abort();
    }
  }
}

/** Convenience factory — `createClient()` is the same as `new BliprClient()`. */
export function createClient(options?: BliprClientOptions): BliprClient {
  return new BliprClient(options);
}
