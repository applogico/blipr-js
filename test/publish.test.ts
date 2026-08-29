import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { BliprClient, BliprError } from '../src/index';

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

function listen(
  handler: (
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
    body: string,
  ) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => handler(req, res, body));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      resolve(typeof addr === 'object' && addr ? addr.port : 0);
    });
  });
}

describe('publish', () => {
  it('sends the body + X-* headers and returns the stored message', async () => {
    let captured: { method?: string; url?: string; headers: Record<string, unknown>; body: string } | undefined;
    const port = await listen((req, res, body) => {
      captured = { method: req.method, url: req.url, headers: req.headers, body };
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

    expect(captured!.method).toBe('POST');
    expect(captured!.url).toBe('/blip/alerts');
    expect(captured!.body).toBe('hello');
    expect(captured!.headers['x-title']).toBe('Title');
    expect(captured!.headers['x-priority']).toBe('5');
    expect(captured!.headers['x-tags']).toBe('a,b');
    expect(captured!.headers['x-markdown']).toBe('true');
    expect(captured!.headers['x-click']).toBe('https://x.y');
    expect(captured!.headers['authorization']).toBe('Bearer ctok');
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
