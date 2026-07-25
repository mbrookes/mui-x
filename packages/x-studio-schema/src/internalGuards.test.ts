import { describe, expect, it } from 'vitest';
import { isPlainRecord } from './internalGuards';

describe('isPlainRecord', () => {
  it('accepts an object literal', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
  });

  it('accepts JSON.parse output (the actual wire/persistence input shape)', () => {
    expect(isPlainRecord(JSON.parse('{"a":1,"b":{"c":2}}'))).toBe(true);
  });

  it('accepts an explicit null-prototype bag', () => {
    expect(isPlainRecord(Object.create(null))).toBe(true);
  });

  it('rejects null', () => {
    expect(isPlainRecord(null)).toBe(false);
  });

  it('rejects an array', () => {
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord([1, 2, 3])).toBe(false);
  });

  it('rejects primitives', () => {
    expect(isPlainRecord('a string')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
    expect(isPlainRecord(true)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
  });

  // Tier2 finding: the old guard (`typeof value === 'object' && value !== null &&
  // !Array.isArray(value)`) was TRUE for every one of these — a `Date`/`RegExp`/`Map`/
  // `Set`/class instance is a non-null, non-array object — so a caller that spread or
  // key-screened one of these treated it as a usable (if empty-looking) record instead
  // of rejecting it as malformed input, silently discarding whatever the exotic object
  // actually carried (e.g. a `Map`'s entries, a `Date`'s timestamp).
  it('rejects a Date instance', () => {
    expect(isPlainRecord(new Date())).toBe(false);
  });

  it('rejects a RegExp instance', () => {
    expect(isPlainRecord(/abc/)).toBe(false);
  });

  it('rejects a Map instance', () => {
    expect(isPlainRecord(new Map([['a', 1]]))).toBe(false);
  });

  it('rejects a Set instance', () => {
    expect(isPlainRecord(new Set([1, 2]))).toBe(false);
  });

  it('rejects an arbitrary class instance', () => {
    class Foo {
      a = 1;
    }
    expect(isPlainRecord(new Foo())).toBe(false);
  });
});
