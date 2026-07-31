/**
 * Regression tests for finding H2: a tool's OUTPUT was the one thing in the agentic
 * loop that nothing bounded — and it is appended to `currentMessages` and re-sent on
 * every remaining turn (O(turns × size)), as well as forwarded to the browser.
 */
import { describe, it, expect } from 'vitest';
import {
  capToolOutput,
  MAX_TOOL_OUTPUT_CHARS,
  MAX_TOOL_OUTPUT_CELL_CHARS,
  MAX_TOOL_OUTPUT_ARRAY_ITEMS,
  MAX_TOOL_OUTPUT_OBJECT_KEYS,
  TOOL_OUTPUT_TRUNCATED_NOTE_KEY,
  TOOL_OUTPUT_TRUNCATED_RESULT_KEY,
  TOOL_OUTPUT_TRUNCATED_SUFFIX,
} from './capToolOutput';

describe('capToolOutput', () => {
  it('returns a within-budget result byte-identical', () => {
    const output = JSON.stringify({ ok: true, rows: [{ id: 1, name: 'Ada' }] });
    expect(capToolOutput(output)).toBe(output);
  });

  it('returns a result exactly at the budget unchanged', () => {
    const output = 'x'.repeat(MAX_TOOL_OUTPUT_CHARS);
    expect(capToolOutput(output)).toBe(output);
  });

  it('caps a single enormous cell value (the 1 MB `notes TEXT` column case)', () => {
    const output = JSON.stringify({
      rows: [{ id: 1, notes: 'n'.repeat(MAX_TOOL_OUTPUT_CHARS + 10_000) }],
    });
    const capped = capToolOutput(output);

    expect(capped.length).toBeLessThan(output.length);
    const parsed = JSON.parse(capped) as {
      rows: Array<{ notes: string }>;
      toolOutputTruncatedNote: string;
    };
    // The row survives — only the oversized cell is trimmed — so the model still
    // gets usable (and explicitly-marked-partial) data.
    expect(parsed.rows[0].notes.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CELL_CHARS + 1);
    expect(parsed.toolOutputTruncatedNote).toMatch(/truncated/i);
  });

  it('caps the row count of an oversized result', () => {
    const rows = Array.from({ length: MAX_TOOL_OUTPUT_ARRAY_ITEMS * 3 }, (_, i) => ({
      id: i,
      pad: 'p'.repeat(200),
    }));
    const capped = capToolOutput(JSON.stringify({ rows }));
    const parsed = JSON.parse(capped) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(MAX_TOOL_OUTPUT_ARRAY_ITEMS);
  });

  it('caps the column count of an oversized result', () => {
    const wideRow: Record<string, string> = {};
    for (let i = 0; i < MAX_TOOL_OUTPUT_OBJECT_KEYS * 3; i += 1) {
      wideRow[`col_${i}`] = 'v'.repeat(500);
    }
    const capped = capToolOutput(JSON.stringify({ rows: [wideRow] }));
    const parsed = JSON.parse(capped) as { rows: Array<Record<string, string>> };
    expect(Object.keys(parsed.rows[0])).toHaveLength(MAX_TOOL_OUTPUT_OBJECT_KEYS);
  });

  it('always ends up within the total budget, even for many small rows', () => {
    const rows = Array.from({ length: MAX_TOOL_OUTPUT_ARRAY_ITEMS }, () => ({
      pad: 'p'.repeat(1_000),
    }));
    const capped = capToolOutput(JSON.stringify({ rows }));
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(capped).toMatch(/truncated/i);
  });

  it('slices and marks an oversized NON-JSON result (a `summarise_page` CSV block)', () => {
    const csv = `a,b,c\n${'1,2,3\n'.repeat(MAX_TOOL_OUTPUT_CHARS / 3)}`;
    const capped = capToolOutput(csv);
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS + 500);
    expect(capped).toMatch(/truncated/i);
  });

  // Finding M4 — the marker was folded in only for an OBJECT root, so an ARRAY or
  // SCALAR root was trimmed and returned BARE, with nothing anywhere saying the data
  // was partial. The whole point of this module is that the model is told; every other
  // suite case happened to use an object root, which is why it survived.
  describe('truncation marker on every root shape', () => {
    it('marks a truncated ARRAY root (the `jsonResult(array)` / server-tool skill shape)', () => {
      const rows = Array.from({ length: MAX_TOOL_OUTPUT_ARRAY_ITEMS * 3 }, (_, i) => ({
        id: i,
        pad: 'p'.repeat(100),
      }));
      const capped = capToolOutput(JSON.stringify(rows));

      const parsed = JSON.parse(capped) as Record<string, unknown>;
      // A bare array has no sibling position for the note, so it is wrapped — the
      // data still round-trips under `result`, but the note is now impossible to miss.
      expect(parsed[TOOL_OUTPUT_TRUNCATED_NOTE_KEY]).toMatch(/truncated/i);
      expect(Array.isArray(parsed[TOOL_OUTPUT_TRUNCATED_RESULT_KEY])).toBe(true);
      expect(parsed[TOOL_OUTPUT_TRUNCATED_RESULT_KEY]).toHaveLength(MAX_TOOL_OUTPUT_ARRAY_ITEMS);
      expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    });

    it('marks a truncated SCALAR (bare JSON string) root', () => {
      const capped = capToolOutput(JSON.stringify('n'.repeat(MAX_TOOL_OUTPUT_CHARS + 100_000)));

      const parsed = JSON.parse(capped) as Record<string, unknown>;
      expect(parsed[TOOL_OUTPUT_TRUNCATED_NOTE_KEY]).toMatch(/truncated/i);
      expect(typeof parsed[TOOL_OUTPUT_TRUNCATED_RESULT_KEY]).toBe('string');
      expect((parsed[TOOL_OUTPUT_TRUNCATED_RESULT_KEY] as string).length).toBeLessThanOrEqual(
        MAX_TOOL_OUTPUT_CELL_CHARS + 1,
      );
    });

    it('does not wrap an array root that needed no trimming', () => {
      const output = JSON.stringify([{ id: 1 }, { id: 2 }]);
      expect(capToolOutput(output)).toBe(output);
    });
  });

  // Same class as the array/scalar root: a trim that leaves no trace. Capping an object
  // KEY is data loss like any other, and it additionally used to let two keys sharing a
  // long prefix collapse onto the same capped string, silently dropping a whole column.
  it('marks — and disambiguates — truncated object KEYS', () => {
    const prefix = 'k'.repeat(MAX_TOOL_OUTPUT_CELL_CHARS + 10);
    const output = JSON.stringify({
      [`${prefix}_a`]: 'first',
      [`${prefix}_b`]: 'second',
      pad: 'p'.repeat(MAX_TOOL_OUTPUT_CHARS),
    });
    const capped = capToolOutput(output);

    const parsed = JSON.parse(capped) as Record<string, unknown>;
    expect(parsed[TOOL_OUTPUT_TRUNCATED_NOTE_KEY]).toMatch(/truncated/i);
    // Both values survive under distinct keys — neither overwrote the other.
    const values = Object.entries(parsed)
      .filter(([key]) => key !== TOOL_OUTPUT_TRUNCATED_NOTE_KEY && key !== 'pad')
      .map(([, value]) => value);
    expect(values).toContain('first');
    expect(values).toContain('second');
  });

  it('fits a result whose size lives entirely in its key COUNT', () => {
    // 400 columns of deeply nested rows: cells narrow to their floor and rows drop to
    // theirs while this is still over budget, so `objectKeys` has to tighten too —
    // before it joined the progressive loop this fell through to the hard slice.
    const wide: Record<string, unknown> = {};
    for (let i = 0; i < MAX_TOOL_OUTPUT_OBJECT_KEYS * 2; i += 1) {
      wide[`column_number_${i}`] = { nested: { deeper: 'v'.repeat(600) } };
    }
    const capped = capToolOutput(JSON.stringify(wide));

    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
    // Well-formed JSON, not a mid-token amputation.
    const parsed = JSON.parse(capped) as Record<string, unknown>;
    expect(parsed[TOOL_OUTPUT_TRUNCATED_NOTE_KEY]).toMatch(/truncated/i);
  });

  // ── The progressive re-trim's later stages, and the exact first-pass cell cap ──
  //
  // The suite above asserts the first-pass caps against the IMPORTED constants, which
  // makes those cases agree with whatever the constants say: multiplying
  // `MAX_TOOL_OUTPUT_CELL_CHARS` by 100 kept every one of them green. And the three
  // FLOORS that the progressive loop tightens toward were never reached at all, so the
  // second and third re-trim stages could be made inert with nothing noticing.

  it('narrows an oversized cell to exactly 4 000 characters on the first structural pass', () => {
    const output = JSON.stringify({
      rows: [{ id: 1, notes: 'n'.repeat(MAX_TOOL_OUTPUT_CHARS + 10_000) }],
    });
    const parsed = JSON.parse(capToolOutput(output)) as { rows: Array<{ notes: string }> };
    // 4 000 kept characters plus the single-character ellipsis the trim appends. The
    // number is spelled out rather than imported: importing it is what let the cap grow
    // 100x unnoticed.
    expect(parsed.rows[0].notes).toHaveLength(4_001);
  });

  it('drops rows all the way to a single one when nothing smaller will fit', () => {
    // Rows so wide that even the SECOND-smallest row count blows the budget, so the
    // loop has to walk `arrayItems` all the way down to its floor before it is allowed
    // to start dropping columns. Nothing else in the suite reaches that floor: every
    // other oversized case fits while `arrayItems` is still at its first-pass value.
    const row: Record<string, Record<string, string>> = {};
    for (let i = 0; i < MAX_TOOL_OUTPUT_OBJECT_KEYS; i += 1) {
      const inner: Record<string, string> = {};
      for (let j = 0; j < 100; j += 1) {
        inner[`s_${j}`] = 'v';
      }
      row[`k_${i}`] = inner;
    }
    const capped = capToolOutput(JSON.stringify(Array.from({ length: 4 }, () => row)));

    const parsed = JSON.parse(capped) as Record<string, unknown>;
    // An array root is wrapped so the truncation note has somewhere to live.
    expect(parsed[TOOL_OUTPUT_TRUNCATED_NOTE_KEY]).toMatch(/truncated/i);
    expect(parsed[TOOL_OUTPUT_TRUNCATED_RESULT_KEY]).toHaveLength(1);
    // Structural, not a hard mid-token slice.
    expect(capped).not.toContain(TOOL_OUTPUT_TRUNCATED_SUFFIX);
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });

  it('tightens the object-key cap below its first-pass value rather than hard-slicing', () => {
    // A result whose size lives entirely in its key COUNT at every level: cells are
    // already tiny and there is not a single array to shrink, so the ONLY structural
    // lever left is dropping columns. If the third re-trim stage is inert this falls
    // through to the hard mid-token slice this module exists to avoid.
    const wide: Record<string, Record<string, string>> = {};
    for (let i = 0; i < 300; i += 1) {
      const inner: Record<string, string> = {};
      for (let j = 0; j < 300; j += 1) {
        inner[`sub_${j}`] = 'v';
      }
      wide[`col_${i}`] = inner;
    }
    const capped = capToolOutput(JSON.stringify(wide));

    // Well-formed JSON, not an amputated string.
    const parsed = JSON.parse(capped) as Record<string, unknown>;
    expect(parsed[TOOL_OUTPUT_TRUNCATED_NOTE_KEY]).toMatch(/truncated/i);
    expect(capped).not.toContain(TOOL_OUTPUT_TRUNCATED_SUFFIX);
    // Narrower than the first-pass column cap on both levels.
    const columns = Object.keys(parsed).filter((k) => k !== TOOL_OUTPUT_TRUNCATED_NOTE_KEY);
    expect(columns.length).toBeLessThan(MAX_TOOL_OUTPUT_OBJECT_KEYS);
    expect(capped.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_CHARS);
  });

  it('keeps an own `__proto__` key from a producer result as DATA', () => {
    // The sibling of the pollution case below. `Object.create(null)` is not only about
    // safety: assigning `__proto__` onto a plain `{}` runs the prototype SETTER, so the
    // key never becomes an own property and the column is silently dropped from the
    // result — data loss with no truncation marker, the one thing this module promises
    // cannot happen.
    const output = `{"__proto__":{"polluted":"yes"},"pad":"${'p'.repeat(MAX_TOOL_OUTPUT_CHARS)}"}`;
    const capped = capToolOutput(output);

    expect(capped).toContain('__proto__');
    const parsed = JSON.parse(capped) as Record<string, unknown>;
    expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(parsed, '__proto__')?.value).toEqual({
      polluted: 'yes',
    });
  });

  it('does not let a `__proto__` key in a producer result reach Object.prototype', () => {
    // Hand-written JSON: an object literal's `__proto__:` sets the prototype rather
    // than an own key, so the payload has to be built as text to reproduce what
    // `JSON.parse` actually yields (an OWN `__proto__` property).
    const output = `{"__proto__":{"polluted":"yes"},"pad":"${'p'.repeat(MAX_TOOL_OUTPUT_CHARS)}"}`;
    capToolOutput(output);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
