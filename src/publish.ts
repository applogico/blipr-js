import { BliprError } from './errors';
import { csv, safeText, serverReason, validateTopic } from './internal';
import type { NotifyMessage, PublishOptions } from './types';

/**
 * Publish a message to a topic. Sends the message as the raw body and metadata
 * as `X-*` headers — the same contract the app and `curl` use.
 */
export async function publish(
  fetchImpl: typeof fetch,
  server: string,
  topic: string,
  message: string,
  opts: PublishOptions,
  clientToken: string | undefined,
): Promise<NotifyMessage> {
  validateTopic(topic);
  if ((message == null || message === '') && !opts.title) {
    throw new BliprError('Publish needs a message or a title.');
  }

  const headers: Record<string, string> = {};
  const set = (key: string, value?: string) => {
    if (value != null && value !== '') headers[key] = value;
  };
  set('X-Title', opts.title);
  set('X-Priority', opts.priority != null ? String(opts.priority) : undefined);
  set('X-Tags', csv(opts.tags));
  set('X-Click', opts.click);
  set('X-Icon', opts.icon);
  if (opts.markdown) set('X-Markdown', 'true');
  set('X-Reply', opts.reply);
  set('X-Options', csv(opts.options));
  set('X-Callback', opts.callback);
  const token = opts.token ?? clientToken;
  if (token) set('Authorization', `Bearer ${token}`);

  const url = `${server}/blip/${topic}`;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: message ?? '',
      signal: opts.signal,
    });
  } catch (cause) {
    throw new BliprError(`Publish to "${topic}" failed: could not reach ${server}.`, {
      cause,
    });
  }

  if (!res.ok) {
    const body = await safeText(res);
    const reason = serverReason(body);
    const suffix = reason ? `: ${reason}` : '.';
    throw new BliprError(`Publish to "${topic}" failed (HTTP ${res.status})${suffix}`, {
      status: res.status,
      body,
    });
  }
  return (await res.json()) as NotifyMessage;
}
