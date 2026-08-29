import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { BliprClient } from '../src/index';

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
