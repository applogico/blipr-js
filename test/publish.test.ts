import { afterEach, describe, expect, it } from 'vitest';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { BliprClient, BliprError } from '../src/index';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('the test server captured no request');
  return value;
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        handler(req, res, body);
      });
    });
    server = s;
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('publish', () => {
  it('sends the body + X-* headers and returns the stored message', async () => {
    let seen:
      | { method?: string; url?: string; headers: Record<string, unknown>; body: string }
      | undefined;
    const port = await listen((req, res, body) => {
      seen = { method: req.method, url: req.url, headers: req.headers, body };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', topic: 'alerts', message: body }));
    });

    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}`, token: 'ctok' });
    const msg = await blipr.publish('alerts', 'hello', {
      title: 'Title',
      priority: 5,
      tags: ['a', 'b'],
      markdown: true,
      click: 'https://x.y',
    });

    const captured = must(seen);
    expect(captured.method).toBe('POST');
    expect(captured.url).toBe('/blip/alerts');
    expect(captured.body).toBe('hello');
    expect(captured.headers['x-title']).toBe('Title');
    expect(captured.headers['x-priority']).toBe('5');
    expect(captured.headers['x-tags']).toBe('a,b');
    expect(captured.headers['x-markdown']).toBe('true');
    expect(captured.headers['x-click']).toBe('https://x.y');
    expect(captured.headers['authorization']).toBe('Bearer ctok');
    expect(msg.id).toBe('m1');
  });

  it('lets a per-call token override the client token; passes a named priority', async () => {
    let headers: Record<string, unknown> = {};
    const port = await listen((req, res) => {
      headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm2', topic: 't' }));
    });

    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}`, token: 'ctok' });
    await blipr.publish('t', 'hi', { priority: 'high', token: 'override' });

    expect(headers['x-priority']).toBe('high');
    expect(headers['authorization']).toBe('Bearer override');
  });

  it('posts a protected topic to /blip/@handle/topic without encoding the @ or the /', async () => {
    let seen: { url?: string; auth?: unknown } | undefined;
    const port = await listen((req, res) => {
      seen = { url: req.url, auth: req.headers['authorization'] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm3', topic: '@alice/home' }));
    });

    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    await blipr.publish('@alice/home', 'hi', { token: 'blipr_pk_x' });

    const captured = must(seen);
    expect(captured.url).toBe('/blip/@alice/home');
    expect(captured.auth).toBe('Bearer blipr_pk_x');
  });

  it('asks an open question with reply: text and sends no options', async () => {
    let headers: Record<string, unknown> = {};
    const port = await listen((req, res) => {
      headers = req.headers;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm4', topic: 't', expected_reply: 'text' }));
    });

    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    const msg = await blipr.publish('t', 'What should it be called?', {
      reply: 'text',
      callback: 'https://x.y/hook',
    });

    expect(headers['x-reply']).toBe('text');
    expect(headers['x-callback']).toBe('https://x.y/hook');
    expect(headers['x-options']).toBeUndefined();
    expect(msg.expected_reply).toBe('text');
  });

  it("reports the server's reason when options come with a non-choice reply", async () => {
    let headers: Record<string, unknown> = {};
    const port = await listen((req, res) => {
      headers = req.headers;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'options are only valid with reply: choice' }));
    });

    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    await expect(
      blipr.publish('t', 'hi', { reply: 'text', options: ['A', 'B'] }),
    ).rejects.toMatchObject({
      status: 400,
      message: 'Publish to "t" failed (HTTP 400): options are only valid with reply: choice',
    });
    expect(headers['x-options']).toBe('A,B');
  });

  it('rejects an invalid protected topic before hitting the network', async () => {
    const blipr = new BliprClient({ server: 'http://127.0.0.1:9' });
    await expect(blipr.publish('@alice', 'hi')).rejects.toBeInstanceOf(BliprError);
    await expect(blipr.publish('@1alice/home', 'hi')).rejects.toBeInstanceOf(BliprError);
  });

  it('rejects an invalid topic before hitting the network', async () => {
    const blipr = new BliprClient({ server: 'http://127.0.0.1:9' });
    await expect(blipr.publish('bad/topic', 'hi')).rejects.toBeInstanceOf(BliprError);
  });

  it('rejects when neither message nor title is given', async () => {
    const blipr = new BliprClient({ server: 'http://127.0.0.1:9' });
    await expect(blipr.publish('t', '')).rejects.toBeInstanceOf(BliprError);
  });

  it('throws a BliprError carrying the HTTP status on a non-2xx', async () => {
    const port = await listen((_req, res) => {
      res.writeHead(403);
      res.end('forbidden');
    });
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    await expect(blipr.publish('t', 'hi')).rejects.toMatchObject({
      name: 'BliprError',
      status: 403,
    });
  });

  it("puts the server's reason in the message on a 404, keeping the raw body", async () => {
    const payload = JSON.stringify({ error: 'Topic not found', code: 'TOPIC_NOT_FOUND' });
    const port = await listen((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(payload);
    });
    const blipr = new BliprClient({ server: `http://127.0.0.1:${port}` });
    await expect(blipr.publish('t', 'hi')).rejects.toMatchObject({
      name: 'BliprError',
      status: 404,
      message: 'Publish to "t" failed (HTTP 404): Topic not found',
      body: payload,
    });
  });
});
