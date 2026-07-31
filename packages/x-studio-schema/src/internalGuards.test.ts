import { describe, expect, it } from 'vitest';
import { isPlainRecord, repairFilterDependsOn } from './internalGuards';

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

describe('repairFilterDependsOn', () => {
  it('returns the same reference when dependsOn is absent or already valid', () => {
    const absent = { id: 'f1' };
    expect(repairFilterDependsOn(absent)).toBe(absent);
    const valid = { id: 'f1', dependsOn: ['a', 'b'] };
    expect(repairFilterDependsOn(valid)).toBe(valid);
  });

  it('returns non-record input as-is', () => {
    expect(repairFilterDependsOn('junk')).toBe('junk');
    expect(repairFilterDependsOn(null)).toBeNull();
  });

  // The repair DELETES the key rather than setting it to `undefined`. That distinction is
  // the package's convention and it is load-bearing here: a surviving `dependsOn:
  // undefined` own key round-trips through `JSON.stringify` as an absent field but is
  // still an own key for `Object.hasOwn`/`in`-based checks, and `serializeDoc` writes the
  // filter verbatim. Asserting on `in` (not on `=== undefined`) is the only assertion that
  // can tell the two apart.
  it.each([
    ['a non-array dependsOn', 'nope'],
    ['a dependsOn with a non-string entry', ['a', 42]],
  ])('deletes the key outright for %s', (_label, dependsOn) => {
    const result = repairFilterDependsOn({ id: 'f1', dependsOn }) as Record<string, unknown>;
    expect('dependsOn' in result).toBe(false);
    // Everything else survives — this is a repair, not a drop.
    expect(result.id).toBe('f1');
  });

  // The size caps are the same `MAX_ARRAY_LENGTH`/`MAX_STRING_LENGTH` the wire boundary's
  // `isStringArray` enforces. This helper is the ONLY check on the paths that skip the wire
  // parser — `applyMutation`'s `addFilter` from a server-built mutation, and `screenFilters`
  // on a persisted/shared doc — so an over-cap `dependsOn` has no other backstop.
  it.each([
    ['an over-cap entry length', ['x'.repeat(10_001)]],
    ['an over-cap array length', Array.from({ length: 501 }, (_, i) => `f${i}`)],
  ])('strips a dependsOn with %s', (_label, dependsOn) => {
    expect('dependsOn' in (repairFilterDependsOn({ id: 'f1', dependsOn }) as object)).toBe(false);
  });

  it.each([
    ['an at-cap entry length', ['x'.repeat(10_000)]],
    ['an at-cap array length', Array.from({ length: 500 }, (_, i) => `f${i}`)],
  ])('keeps a dependsOn with %s', (_label, dependsOn) => {
    const entry = { id: 'f1', dependsOn };
    expect(repairFilterDependsOn(entry)).toBe(entry);
  });
});
