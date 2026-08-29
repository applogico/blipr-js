# @blipr/js

[![npm version](https://img.shields.io/npm/v/@blipr/js)](https://www.npmjs.com/package/@blipr/js)
[![CI](https://github.com/applogico/blipr-js/actions/workflows/ci.yml/badge.svg)](https://github.com/applogico/blipr-js/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@blipr/js)](./LICENSE)
[![Node](https://img.shields.io/node/v/@blipr/js)](https://nodejs.org)

Tiny, zero-dependency client for [Blipr](https://apps.apple.com/us/app/blipr-notifications/id6785094245) — **publish and subscribe to notifications from anywhere.** curl your phone.

- **Zero runtime dependencies.** Runs on Node ≥ 18, browsers, and edge runtimes (anywhere `fetch` streams).
- **Publish** with title, priority, tags, click, markdown, and the reply/ask loop.
- **Subscribe** over SSE with auto-reconnect and resume-from-last-message.
- **Token-ready from v1** — pass a token and it's forwarded for protected topics.

## Install

```sh
npm install @blipr/js
```

## Publish

```ts
import { BliprClient } from '@blipr/js';

const blipr = new BliprClient(); // defaults to https://blipr.dev

await blipr.publish('my-alerts', 'Build finished', {
  title: 'CI',
  priority: 4,            // 1–5, or 'min'|'low'|'default'|'high'|'max'|'urgent'
  tags: ['rocket'],       // string or string[]
  click: 'https://ci.example.com/run/42',
});
```

On blipr.dev the topic has to exist first: sign in to the Blipr app and subscribe to `my-alerts` to create it. Publishing to a name that does not exist returns 404, while a self-hosted server still creates the topic on the first publish.

`publish()` resolves with the stored message (including its `id`).

## Subscribe

Callback style, with automatic reconnect:

```ts
const sub = blipr.subscribe('my-alerts', (msg) => {
  console.log(msg.title, msg.message);
});

// later
sub.close();
```

On blipr.dev subscribing to a topic that already exists needs no account, but subscribing to a name that does not exist returns 401 rather than creating it. Create the topic in the Blipr app first; a self-hosted server still creates it on the first subscribe.

Async-iterator style:

```ts
for await (const msg of blipr.messages('my-alerts')) {
  console.log(msg.message);
  if (done) break; // breaking closes the connection
}
```

Catch up on history, then stream — or just poll and stop:

```ts
blipr.subscribe('my-alerts', onMessage, { since: '10m' });       // last 10 minutes, then live
const backlog = [];
for await (const m of blipr.messages('my-alerts', { poll: true })) backlog.push(m); // one-shot
```

Subscribe to multiple topics at once with a comma-separated list: `blipr.subscribe('a,b,c', ...)`.

## Protected topics (tokens)

Set a token on the client (or per call) and it's sent as `Authorization: Bearer …`:

```ts
const blipr = new BliprClient({ token: process.env.BLIPR_TOKEN });
await blipr.publish('deploys', 'Promoting to prod');   // authenticated

// per-call override
await blipr.publish('deploys', 'hi', { token: 'another-token' });
```

## Ask for a reply

```ts
await blipr.publish('deploys', 'Promote to prod?', {
  reply: 'choice',
  options: ['Promote', 'Hold', 'Rollback'],
  callback: 'https://ci.example.com/blipr-hook', // the reply is POSTed here
});
```

`reply: 'binary'` gives Yes/No, `reply: 'ack'` a single Acknowledge. The first reply wins and locks the answer.

## Self-hosting

Point the client at your own notify server:

```ts
const blipr = new BliprClient({ server: 'https://notify.mycompany.internal' });
```

## API

| Method | Description |
|---|---|
| `new BliprClient({ server?, token?, fetch? })` | Create a client. |
| `publish(topic, message, options?)` | Publish; resolves with the message. |
| `subscribe(topic, onMessage, options?)` | Stream messages via a callback; returns `{ close(), done }`. |
| `messages(topic, options?)` | Async-iterable of messages. |

`PublishOptions`: `title`, `priority`, `tags`, `click`, `icon`, `markdown`, `reply`, `options`, `callback`, `token`, `signal`.
`SubscribeOptions`: `since`, `poll`, `filter`, `token`, `signal`, `onOpen`, `onError`.

Errors throw a `BliprError` (with `.status` and `.body` for HTTP failures).

## Environment notes

- **Node** ≥ 18, **Deno**, **Bun**, **edge runtimes** — work out of the box (global `fetch` with streaming). On older Node, pass a `fetch` (e.g. `undici`). This is the primary use case: CI, scripts, servers, integrations.
- **Browser** — the client is browser-safe (no Node-only imports). Cross-origin browser requests require the notify server to allow your origin via CORS (a standard browser requirement); pages served same-origin as the server need no extra setup. For browser publishing, also remember topic names are public unless protected.

## License

MIT © Applogico
