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

  it('does not let a `__proto__` key in a producer result reach Object.prototype', () => {
    // Hand-written JSON: an object literal's `__proto__:` sets the prototype rather
    // than an own key, so the payload has to be built as text to reproduce what
    // `JSON.parse` actually yields (an OWN `__proto__` property).
    const output = `{"__proto__":{"polluted":"yes"},"pad":"${'p'.repeat(MAX_TOOL_OUTPUT_CHARS)}"}`;
    capToolOutput(output);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
