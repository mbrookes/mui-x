import { describe, it, expect } from 'vitest';
import { lookup } from './safeLookup';

/**
 * `lookup` exists because a bare `record[key]` on a plain object literal walks the prototype
 * chain: a doc- or LLM-authored key that names an `Object.prototype` member resolves an
 * inherited, truthy-but-wrong value, which neither `?.` nor `?? fallback` can catch.
 */
describe('lookup', () => {
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

  const record: Record<string, number> = { a: 1, b: 2 };

  it('returns own values', () => {
    expect(lookup(record, 'a')).toBe(1);
    expect(lookup(record, 'b')).toBe(2);
  });

  it('returns undefined for missing keys', () => {
    expect(lookup(record, 'nope')).toBeUndefined();
  });

  PROTO_KEYS.forEach((key) => {
    it(`returns undefined for the inherited key "${key}"`, () => {
      expect(lookup(record, key)).toBeUndefined();
      // The bug this guards: the bare index resolves something truthy, so `?? fallback` is
      // never reached.
      expect((record as Record<string, unknown>)[key] ?? 'fallback').not.toBe('fallback');
    });
  });

  it('still returns an OWN value that shadows a prototype member', () => {
    const shadowing: Record<string, number> = { toString: 7 };
    // Explicit type args: inferring `K` from the literal key would narrow it to
    // `'toString'`, which a `Record<string, number>` argument does not satisfy.
    expect(lookup<string, number>(shadowing, 'toString')).toBe(7);
  });

  it('returns undefined for a nullish record or key', () => {
    expect(lookup(undefined, 'a')).toBeUndefined();
    expect(lookup(null, 'a')).toBeUndefined();
    expect(lookup(record, undefined)).toBeUndefined();
    expect(lookup(record, null)).toBeUndefined();
  });

  it('preserves falsy own values instead of collapsing them to undefined', () => {
    const falsy: Record<string, number | string | boolean> = { zero: 0, empty: '', off: false };
    expect(lookup(falsy, 'zero')).toBe(0);
    expect(lookup(falsy, 'empty')).toBe('');
    expect(lookup(falsy, 'off')).toBe(false);
  });
});
