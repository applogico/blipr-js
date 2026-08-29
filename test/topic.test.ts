import { describe, expect, it } from 'vitest';
import { topicPath, validateTopic } from '../src/internal';
import { BliprError } from '../src/errors';

describe('validateTopic', () => {
  it('accepts a bare public topic', () => {
    for (const topic of ['alerts', 'home-server_1', 'a', 'a'.repeat(64)]) {
      expect(validateTopic(topic)).toBe(topic);
    }
  });

  it('accepts a protected address', () => {
    for (const topic of ['@alice/tickets', '@_a1/x', `@${'h'.repeat(30)}/${'t'.repeat(64)}`]) {
      expect(validateTopic(topic)).toBe(topic);
    }
  });

  it('rejects an invalid handle', () => {
    // Uppercase, a dash, too short, a leading digit, and an empty handle.
    for (const topic of ['@Alice/t', '@has-dash/t', '@ab/t', '@1alice/t', '@/t']) {
      expect(() => validateTopic(topic)).toThrow(BliprError);
    }
    expect(() => validateTopic(`@${'h'.repeat(31)}/t`)).toThrow(/handle/);
  });

  it('rejects an invalid leaf', () => {
    for (const topic of ['@alice/has space', '@alice/has.dot', '@alice/a/b', '@alice/']) {
      expect(() => validateTopic(topic)).toThrow(BliprError);
    }
  });

  it('rejects a leaf that is too long', () => {
    expect(() => validateTopic('a'.repeat(65))).toThrow(BliprError);
    expect(() => validateTopic(`@alice/${'a'.repeat(65)}`)).toThrow(BliprError);
  });
});

describe('topicPath', () => {
  it('encodes each path segment on its own', () => {
    expect(topicPath('@alice/tickets')).toBe('%40alice/tickets');
    expect(topicPath('alerts')).toBe('alerts');
  });
});
