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

/** Serve a fixed list of SSE frames, then end the response. */
/** Answer every request with one status and body. */
function refusingServer(status: number, body: string): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve(portOf(server!)));
  });
}

function sseServer(frames: string[]): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of frames) res.write(f);
      res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve(portOf(server!)));
  });
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
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"1","to');
      setTimeout(() => {
        res.write('pic":"t","message":"split"}\n\n');
        res.end();
      }, 10);
    });
    const port: number = await new Promise((r) =>
      server!.listen(0, '127.0.0.1', () => r(portOf(server!))),
    );
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: string[] = [];
    const sub = blipr.subscribe('t', (m) => got.push(String(m.message)), { poll: true });
    await sub.done;
    expect(got).toEqual(['split']);
  });

  it('close() ends a live subscription', async () => {
    // A server that stays open (never ends) so only close() stops it.
    server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"id":"1","topic":"t","message":"live"}\n\n');
      // keep the connection open
    });
    const port: number = await new Promise((r) =>
      server!.listen(0, '127.0.0.1', () => r(portOf(server!))),
    );
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });

    const got: string[] = [];
    const sub = blipr.subscribe('t', (m) => got.push(String(m.message)));
    await new Promise((r) => setTimeout(r, 50));
    sub.close();
    await sub.done;
    expect(got).toEqual(['live']);
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
