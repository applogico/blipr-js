import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { BliprClient, type ExpectedReply } from '../src/index';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function portOf(s: Server): number {
  const addr = s.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

function start(s: Server): Promise<number> {
  server = s;
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      resolve(portOf(s));
    });
  });
}

/** Answer every request with one status and body. */
function refusingServer(status: number, body: string): Promise<number> {
  return start(
    createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    }),
  );
}

function sseServer(frames: string[]): Promise<number> {
  return start(
    createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of frames) res.write(f);
      res.end();
    }),
  );
}

/** Record every request target, then end the stream so a poll returns. */
function urlRecordingServer(seen: string[]): Promise<number> {
  return start(
    createServer((req, res) => {
      seen.push(req.url ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"event":"open"}\n\n');
    }),
  );
}

/** The request target the SDK puts on the wire for `topic`. */
async function requestedUrl(topic: string): Promise<string> {
  const seen: string[] = [];
  const port = await urlRecordingServer(seen);
  const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
  await blipr.subscribe(topic, () => {}, { poll: true }).done;
  return seen.join('|');
}

/** Serve the nth request the nth batch of frames and end it; later requests stay open. */
function droppingServer(batches: string[][], seen: string[]): Promise<number> {
  return start(
    createServer((req, res) => {
      const n = seen.push(req.url ?? '') - 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (n >= batches.length) return;
      for (const f of batches[n]) res.write(f);
      res.end();
    }),
  );
}

const frame = (body: object) => `data: ${JSON.stringify(body)}\n\n`;
const open = frame({ id: 'ctl-open', event: 'open', topic: 't', time: 1 });
const keepalive = frame({ id: 'ctl-keep', event: 'keepalive', topic: 't', time: 2 });

async function waitFor(check: () => boolean): Promise<void> {
  for (let i = 0; i < 300 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
}

/** Subscribe live until `stop` holds, returning what reached the callback. */
async function subscribeUntil(
  port: number,
  stop: (got: string[]) => boolean,
  since?: string,
): Promise<string[]> {
  const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
  const got: string[] = [];
  const sub = blipr.subscribe('t', (m) => got.push(m.id), since ? { since } : {});
  await waitFor(() => stop(got));
  sub.close();
  await sub.done;
  return got;
}

describe('subscribe reconnect', () => {
  it('resumes from the last message cursor, untouched by control frames', async () => {
    const seen: string[] = [];
    const port = await droppingServer(
      [
        [
          open,
          frame({ id: 'a1', event: 'message', topic: 't', time: 10, cursor: 41 }),
          frame({ id: 'a2', event: 'message', topic: 't', time: 11, cursor: 42 }),
          keepalive,
        ],
      ],
      seen,
    );
    await subscribeUntil(port, () => seen.length >= 2, '10m');
    expect(seen[1]).toBe('/blip/t/sse?since=c42');
  });

  it('does not deliver a replayed message twice', async () => {
    const seen: string[] = [];
    const a2 = frame({ id: 'a2', event: 'message', topic: 't', time: 11, cursor: 42 });
    const port = await droppingServer(
      [
        [open, frame({ id: 'a1', event: 'message', topic: 't', time: 10, cursor: 41 }), a2],
        [open, a2, frame({ id: 'a3', event: 'message', topic: 't', time: 12, cursor: 43 })],
      ],
      seen,
    );
    const got = await subscribeUntil(port, (g) => g.includes('a3') || seen.length >= 3);
    expect(got).toEqual(['a1', 'a2', 'a3']);
  });

  it("keeps the caller's since when the first connection drops before any message", async () => {
    const seen: string[] = [];
    const port = await droppingServer([[open, keepalive]], seen);
    await subscribeUntil(port, () => seen.length >= 2, '10m');
    expect(seen).toEqual(['/blip/t/sse?since=10m', '/blip/t/sse?since=10m']);
  });

  it('reconnects with no since when the caller gave none and nothing arrived', async () => {
    const seen: string[] = [];
    const port = await droppingServer([[open]], seen);
    await subscribeUntil(port, () => seen.length >= 2);
    expect(seen).toEqual(['/blip/t/sse', '/blip/t/sse']);
  });

  it('falls back to the message time when a server sends no cursor', async () => {
    const seen: string[] = [];
    const a1 = frame({ id: 'a1', event: 'message', topic: 't', time: 1700000000 });
    const port = await droppingServer(
      [
        [open, a1],
        [open, a1, frame({ id: 'a2', event: 'message', topic: 't', time: 1700000000 })],
      ],
      seen,
    );
    const got = await subscribeUntil(port, (g) => g.includes('a2') || seen.length >= 3);
    expect(seen[1]).toBe('/blip/t/sse?since=1700000000');
    expect(got).toEqual(['a1', 'a2']);
  });
});

describe('subscribe', () => {
  it('parses SSE frames, fires onOpen once, and skips control frames', async () => {
    const port = await sseServer([
      'data: {"event":"open"}\n\n',
      'data: {"id":"1","topic":"t","message":"one"}\n\n',
      'data: {"event":"keepalive"}\n\n',
      'data: {"id":"2","topic":"t","message":"two"}\n\n',
    ]);
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: string[] = [];
    let opened = 0;
    const sub = blipr.subscribe('t', (m) => got.push(String(m.message)), {
      poll: true,
      onOpen: () => opened++,
    });
    await sub.done;

    expect(opened).toBe(1);
    expect(got).toEqual(['one', 'two']);
  });

  it('exposes messages() as an async iterable that stops on break', async () => {
    const port = await sseServer([
      'data: {"id":"1","topic":"t","message":"a"}\n\n',
      'data: {"id":"2","topic":"t","message":"b"}\n\n',
    ]);
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: string[] = [];
    for await (const m of blipr.messages('t', { poll: true })) {
      got.push(String(m.message));
      if (got.length === 1) break;
    }
    expect(got).toEqual(['a']);
  });

  it('reassembles a message split across chunks', async () => {
    const port = await start(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"1","to');
        setTimeout(() => {
          res.write('pic":"t","message":"split"}\n\n');
          res.end();
        }, 10);
      }),
    );
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: string[] = [];
    const sub = blipr.subscribe('t', (m) => got.push(String(m.message)), { poll: true });
    await sub.done;
    expect(got).toEqual(['split']);
  });

  it('close() ends a live subscription', async () => {
    // A server that stays open (never ends) so only close() stops it.
    const port = await start(
      createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"id":"1","topic":"t","message":"live"}\n\n');
        // keep the connection open
      }),
    );
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: string[] = [];
    const sub = blipr.subscribe('t', (m) => got.push(String(m.message)));
    await new Promise((r) => setTimeout(r, 50));
    sub.close();
    await sub.done;
    expect(got).toEqual(['live']);
  });

  it('surfaces the reply kind a message asks for', async () => {
    const port = await sseServer([
      frame({ id: '1', topic: 't', message: 'Name it?', expected_reply: 'text' }),
      frame({ id: '2', topic: 't', message: 'Pick', expected_reply: 'choice', options: ['A', 'B'] }),
    ]);
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: { reply?: ExpectedReply; options?: string[] }[] = [];
    for await (const m of blipr.messages('t', { poll: true })) {
      got.push({ reply: m.expected_reply, options: m.options });
    }
    expect(got).toEqual([
      { reply: 'text', options: undefined },
      { reply: 'choice', options: ['A', 'B'] },
    ]);
  });

  it('requests one topic at the plain topic path', async () => {
    expect(await requestedUrl('deploys')).toBe('/blip/deploys/sse?poll=1');
  });

  it('requests a comma-separated list unchanged', async () => {
    expect(await requestedUrl('ci,deploys')).toBe('/blip/ci,deploys/sse?poll=1');
  });

  it('requests a list written with spaces at the same URL as one without', async () => {
    expect(await requestedUrl('ci, deploys ,  builds')).toBe(
      '/blip/ci,deploys,builds/sse?poll=1',
    );
  });

  it('requests a protected topic at /blip/@handle/topic/sse with the @ and / intact', async () => {
    expect(await requestedUrl('@alice/home')).toBe('/blip/@alice/home/sse?poll=1');
  });

  it('sends the token when subscribing to a protected topic', async () => {
    let auth: unknown;
    const port = await start(
      createServer((req, res) => {
        auth = req.headers['authorization'];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('data: {"event":"open"}\n\n');
      }),
    );
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    await blipr.subscribe('@alice/home', () => {}, { poll: true, token: 'blipr_pk_x' }).done;
    expect(auth).toBe('Bearer blipr_pk_x');
  });

  it('refuses a protected topic inside a comma-separated list without a request', async () => {
    const seen: string[] = [];
    const port = await urlRecordingServer(seen);
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    const iterate = async () => {
      await blipr.messages('ci,@alice/home', { poll: true })[Symbol.asyncIterator]().next();
    };
    await expect(iterate()).rejects.toThrow(/protected topic can't be in a list/);
    expect(seen).toEqual([]);
  });

  it('refuses an invalid protected topic without a request', async () => {
    const seen: string[] = [];
    const port = await urlRecordingServer(seen);
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    const iterate = async () => {
      await blipr.messages('@alice', { poll: true })[Symbol.asyncIterator]().next();
    };
    await expect(iterate()).rejects.toThrow(/Invalid protected topic/);
    expect(seen).toEqual([]);
  });

  it('reports the server reason when a subscribe is refused', async () => {
    const port = await refusingServer(401, '{"error":"Sign in to create a topic"}');
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    let failure: unknown;
    await blipr.subscribe('brand-new', () => {}, {
      poll: true,
      onError: (err) => (failure = err),
    }).done;

    expect((failure as Error).message).toBe(
      'Subscribe to "brand-new" failed (HTTP 401): Sign in to create a topic',
    );
  });
});
