import { describe, it, expect } from 'vitest';
import { stableStringify } from './stableStringify';

describe('stableStringify', () => {
  // ─── Baseline behaviour ─────────────────────────────────────────────────────

  it('is insensitive to object key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
  });

  it('is sensitive to array order', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('maps undefined (and other JSON-invisible values) to a deterministic string', () => {
    expect(stableStringify(undefined)).toBe('null');
    expect(stableStringify(() => {})).toBe('null');
    expect(typeof stableStringify(undefined)).toBe('string');
  });

  // ─── Date (H2) ──────────────────────────────────────────────────────────────
  //
  // `JSON.stringify` sees no own enumerable keys on a Date, so the object branch used to
  // emit `{}` for EVERY Date — two different dates produced one cache key. `filterUtils`
  // explicitly supports Date filter values, so a host driving the filter API with
  // `new Date(...)` got the previous date's rows out of the L3 cache and the wrong server
  // response out of `StudioRequestCache` for its whole TTL.

  it('distinguishes two different Dates', () => {
    const a = stableStringify(new Date('2024-01-01T00:00:00.000Z'));
    const b = stableStringify(new Date('2025-01-01T00:00:00.000Z'));
    expect(a).not.toBe(b);
    // Neither may be the old, collapsed-to-empty-object encoding.
    expect(a).not.toBe('{}');
    expect(b).not.toBe('{}');
  });

  it('encodes equal Dates identically (cache hits still work)', () => {
    expect(stableStringify(new Date('2024-01-01T00:00:00.000Z'))).toBe(
      stableStringify(new Date('2024-01-01T00:00:00.000Z')),
    );
  });

  it('distinguishes a Date nested inside a filter-shaped value', () => {
    const jan = { from: new Date('2024-01-01T00:00:00.000Z'), to: new Date('2024-01-31') };
    const feb = { from: new Date('2024-02-01T00:00:00.000Z'), to: new Date('2024-02-29') };
    expect(stableStringify(jan)).not.toBe(stableStringify(feb));
  });

  it('does not confuse a Date with a plain object', () => {
    expect(stableStringify(new Date(0))).not.toBe(stableStringify({}));
  });

  // ─── Map / Set (H2) ─────────────────────────────────────────────────────────

  it('distinguishes two different Maps and ignores insertion order', () => {
    const a = stableStringify(
      new Map([
        ['x', 1],
        ['y', 2],
      ]),
    );
    const b = stableStringify(
      new Map([
        ['y', 2],
        ['x', 1],
      ]),
    );
    const c = stableStringify(new Map([['x', 9]]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe('{}');
  });

  it('distinguishes two different Sets and ignores insertion order', () => {
    const a = stableStringify(new Set(['EU', 'US']));
    const b = stableStringify(new Set(['US', 'EU']));
    const c = stableStringify(new Set(['EU']));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe('{}');
  });

  it('does not confuse an empty Map with an empty Set', () => {
    expect(stableStringify(new Map())).not.toBe(stableStringify(new Set()));
  });

  // ─── Non-finite numbers / bigint (H2) ───────────────────────────────────────

  it('distinguishes NaN, ±Infinity and null from each other', () => {
    const encodings = [
      stableStringify(Number.NaN),
      stableStringify(Number.POSITIVE_INFINITY),
      stableStringify(Number.NEGATIVE_INFINITY),
      stableStringify(null),
    ];
    // All four used to encode as 'null'.
    expect(new Set(encodings).size).toBe(4);
  });

  it('encodes a bigint instead of throwing', () => {
    // JSON.stringify throws a TypeError on a bigint — inside a render-time useMemo that
    // would take down the widget tree.
    expect(() => stableStringify({ big: 10n })).not.toThrow();
    expect(stableStringify({ big: 10n })).not.toBe(stableStringify({ big: 11n }));
  });

  // ─── Cycle guard / depth cap (H2) ───────────────────────────────────────────

  it('does not throw on a self-referential value', () => {
    const cyclic: Record<string, unknown> = { field: 'region' };
    cyclic.self = cyclic;
    expect(() => stableStringify(cyclic)).not.toThrow();
    expect(stableStringify(cyclic)).toContain('#Cycle');
  });

  it('does not throw on a cycle through an array', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => stableStringify(arr)).not.toThrow();
  });

  it('still encodes a DAG (same object in two sibling positions) fully, twice', () => {
    const shared = { a: 1 };
    // The cycle guard must be path-scoped, not global — a repeated sibling is not a cycle.
    expect(stableStringify({ x: shared, y: shared })).toBe(
      stableStringify({ x: { a: 1 }, y: { a: 1 } }),
    );
  });

  it('does not throw (nor recurse forever) on a pathologically deep value', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 5000; i += 1) {
      deep = { nested: deep };
    }
    expect(() => stableStringify(deep)).not.toThrow();
    expect(stableStringify(deep)).toContain('#MaxDepth');
  });
});
