import { describe, expect, it } from 'vitest';
import { BliprError } from '../src/index';
import { validateTopic } from '../src/internal';

describe('validateTopic', () => {
  it.each(['alerts', 'home-server_1', 'A', 'a'.repeat(64)])(
    'accepts the public name %s',
    (topic) => {
      expect(validateTopic(topic)).toBe(topic);
    },
  );

  it.each(['', 'a'.repeat(65), 'a/b', 'a,b', 'a b', 'a.b', 'émoji', '%40alice/home'])(
    'rejects the public name %j',
    (topic) => {
      expect(() => validateTopic(topic)).toThrow(BliprError);
    },
  );

  it.each([
    '@alice/home',
    '@Alice/Home',
    '@_under/x',
    '@abc/a',
    '@alice_01/home-server_1',
    `@${'a'.repeat(30)}/${'b'.repeat(64)}`,
  ])('accepts the protected name %s', (topic) => {
    expect(validateTopic(topic)).toBe(topic);
  });

  it.each([
    '@alice',
    '@alice/',
    '@/home',
    '@ab/home',
    `@${'a'.repeat(31)}/home`,
    '@1alice/home',
    '@has-dash/home',
    '@has.dot/home',
    '@alice/a/b',
    `@alice/${'b'.repeat(65)}`,
    '@alice/a b',
    '@@alice/home',
  ])('rejects the protected name %j', (topic) => {
    expect(() => validateTopic(topic)).toThrow(BliprError);
  });

  it('explains the protected form in its error', () => {
    expect(() => validateTopic('@alice')).toThrow(/@handle\/topic/);
  });
});
