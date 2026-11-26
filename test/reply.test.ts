import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { BliprClient, BliprError } from '../src/index';

let server: Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

interface Fake {
  /** Frames written when a stream opens; the connection then stays open. */
  frames: object[];
  /** What the reply endpoint answers, per request. */
  reply: (wait: string | null) => object;
  /** Every request path, in order. */
  seen: string[];
  /** The open streams, for writing later frames. */
  streams: ServerResponse[];
}

function startFake(fake: Fake): Promise<string> {
  const s = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    fake.seen.push(url.pathname + url.search);
    if (url.pathname.endsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const f of fake.frames) res.write(`data: ${JSON.stringify(f)}\n\n`);
      fake.streams.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(fake.reply(url.searchParams.get('wait'))));
  });
  server = s;
  return new Promise((resolve) => {
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
    });
  });
}

const pending = () => ({ status: 'pending' });

describe('waitForReply', () => {
  it('returns the answer the stream delivers, ignoring other questions', async () => {
    const fake: Fake = { frames: [{ event: 'open', replies: true }], reply: pending, seen: [], streams: [] };
    const client = new BliprClient({ server: await startFake(fake), token: 'blipr_pk_x' });

    const wait = client.waitForReply('deploys', 'abc123');
    await expect.poll(() => fake.seen.length).toBe(2);
    const [stream] = fake.streams;
    stream.write(`data: ${JSON.stringify({ event: 'message', id: 'zzz', message: 'hi' })}\n\n`);
    stream.write(`data: ${JSON.stringify({ event: 'reply', message_id: 'other', value: 'no', replied_at: 1 })}\n\n`);
    stream.write(`data: ${JSON.stringify({ event: 'reply', message_id: 'abc123', value: 'ship it', replied_at: 42 })}\n\n`);

    expect(await wait).toEqual({ value: 'ship it', replied_at: 42 });
    // One stream and one check on connect: no repeated requests while waiting.
    expect(fake.seen).toEqual(['/blip/deploys/sse?replies=1', '/blip/deploys/abc123/reply?wait=0']);
  });

  it('picks up an answer whose stream event never arrived, on the next keepalive', async () => {
    let answered = false;
    const fake: Fake = {
      frames: [{ event: 'open', replies: true }],
      reply: () => (answered ? { status: 'answered', value: 'yes', replied_at: 5 } : pending()),
      seen: [],
      streams: [],
    };
    const client = new BliprClient({ server: await startFake(fake) });
    const wait = client.waitForReply('deploys', 'abc123');
    await expect.poll(() => fake.seen.length).toBe(2);
    answered = true;
    fake.streams[0]?.write(`data: ${JSON.stringify({ event: 'keepalive' })}\n\n`);
    expect(await wait).toEqual({ value: 'yes', replied_at: 5 });
  });

  it('returns an answer given before the stream opened', async () => {
    const fake: Fake = {
      frames: [{ event: 'open', replies: true }],
      reply: () => ({ status: 'answered', value: 'yes', replied_at: 7 }),
      seen: [],
      streams: [],
    };
    const client = new BliprClient({ server: await startFake(fake) });
    expect(await client.waitForReply('deploys', 'abc123')).toEqual({ value: 'yes', replied_at: 7 });
  });

  it('asks the reply endpoint when the server does not stream answers', async () => {
    const fake: Fake = {
      frames: [{ event: 'open' }],
      reply: (wait) => (wait === '0' ? pending() : { status: 'answered', value: 'ack', replied_at: 9 }),
      seen: [],
      streams: [],
    };
    const client = new BliprClient({ server: await startFake(fake) });
    expect(await client.waitForReply('deploys', 'abc123')).toEqual({ value: 'ack', replied_at: 9 });
    expect(fake.seen.at(-1)).toBe('/blip/deploys/abc123/reply?wait=300');
  });

  it('resolves with undefined when the signal aborts first', async () => {
    const fake: Fake = { frames: [{ event: 'open', replies: true }], reply: pending, seen: [], streams: [] };
    const client = new BliprClient({ server: await startFake(fake) });
    const stop = new AbortController();
    const wait = client.waitForReply('deploys', 'abc123', { signal: stop.signal });
    await expect.poll(() => fake.seen.length).toBe(2);
    stop.abort();
    expect(await wait).toBeUndefined();
  });

  it('throws when the server refuses the topic', async () => {
    const s = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Topic not found' }));
    });
    server = s;
    const base = await new Promise<string>((resolve) => {
      s.listen(0, '127.0.0.1', () => {
        const addr = s.address();
        resolve(`http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`);
      });
    });
    const client = new BliprClient({ server: base });
    await expect(client.waitForReply('nope', 'abc123')).rejects.toBeInstanceOf(BliprError);
  });
});
