/**
 * Unit tests for `mcp/utilityTools.ts`'s handler factory, exercised directly
 * (rather than through the full `buildStudioMcpServer` composition root).
 *
 * Focuses on the `get_recent_changes` response bound (finding ai-mw 3.4): the
 * handler must cap how much of the (untrusted-sized) mutation log it serializes
 * into a single tool response, regardless of how large the injected array is.
 * `render_chart`'s own hardening is covered by `../chartRenderer.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import { createUtilityToolHandlers } from './utilityTools';
import type { StudioAIRecentMutation } from '../models/aiTypes';

/** The hard cap enforced by the handler (kept in sync with utilityTools.ts). */
const MAX_RECENT_CHANGES_RESPONSE = 50;

function makeLog(count: number): StudioAIRecentMutation[] {
  return Array.from({ length: count }, (_, i) => ({
    label: `mutation-${i}`,
    at: new Date(2020, 0, 1, 0, 0, i).toISOString(),
  }));
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

describe('createUtilityToolHandlers — get_recent_changes', () => {
  it('returns the log unchanged when it is within the cap', () => {
    const recentChanges = makeLog(3);
    const handlers = createUtilityToolHandlers({ recentChanges });
    const parsed = parse(handlers.get_recent_changes({}));
    // Un-truncated: exact injected shape, no sentinel.
    expect(parsed).toEqual(recentChanges);
  });

  it('accepts an undefined args object without throwing', () => {
    const handlers = createUtilityToolHandlers({ recentChanges: makeLog(2) });
    expect(() => handlers.get_recent_changes(undefined)).not.toThrow();
  });

  it('caps the response even when the underlying history is much larger', () => {
    const recentChanges = makeLog(500);
    const handlers = createUtilityToolHandlers({ recentChanges });
    const parsed = parse(handlers.get_recent_changes({}));
    // Cap (MAX) most-recent entries + one truncation sentinel.
    expect(parsed.length).toBe(MAX_RECENT_CHANGES_RESPONSE + 1);
    // The sentinel is first and reports how many entries were omitted.
    expect(parsed[0].label).toMatch(/older change\(s\) omitted/);
    // The kept entries are the MOST RECENT ones (tail of the log), oldest first.
    expect(parsed[1].label).toBe('mutation-450');
    expect(parsed[parsed.length - 1].label).toBe('mutation-499');
  });

  it('never exceeds the hard cap even when a caller requests a huge limit', () => {
    const recentChanges = makeLog(500);
    const handlers = createUtilityToolHandlers({ recentChanges });
    const parsed = parse(handlers.get_recent_changes({ limit: 100000 }));
    // Clamped to MAX (+ sentinel), not the requested 100000.
    expect(parsed.length).toBe(MAX_RECENT_CHANGES_RESPONSE + 1);
  });

  it('honours a smaller caller-supplied limit', () => {
    const recentChanges = makeLog(30);
    const handlers = createUtilityToolHandlers({ recentChanges });
    const parsed = parse(handlers.get_recent_changes({ limit: 5 }));
    // 5 most-recent entries + sentinel.
    expect(parsed.length).toBe(6);
    expect(parsed[1].label).toBe('mutation-25');
    expect(parsed[parsed.length - 1].label).toBe('mutation-29');
  });

  it('clamps a negative / NaN limit up to a bounded response rather than widening it', () => {
    const recentChanges = makeLog(500);
    const handlers = createUtilityToolHandlers({ recentChanges });
    for (const bad of [-1, 0, Number.NaN, '<script>' as unknown as number]) {
      const parsed = parse(handlers.get_recent_changes({ limit: bad }));
      // Falls back to the hard cap (never unbounded, never the full 500).
      expect(parsed.length).toBeLessThanOrEqual(MAX_RECENT_CHANGES_RESPONSE + 1);
      expect(parsed.length).toBeGreaterThan(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// finding M6 — render_chart must not return the same SVG twice, uncapped
// ─────────────────────────────────────────────────────────────────────────────

describe('createUtilityToolHandlers — render_chart result size (finding M6)', () => {
  const barArgs = {
    type: 'bar',
    data: [
      { label: 'A', value: 1 },
      { label: 'B', value: 2 },
    ],
  };

  it('returns the image only by default (the raw SVG is no longer duplicated)', () => {
    const handlers = createUtilityToolHandlers({ recentChanges: [] });
    const view: any = handlers.render_chart(barArgs);
    expect(view.content).toHaveLength(1);
    expect(view.content[0].type).toBe('image');
    expect(view.content[0].mimeType).toBe('image/svg+xml');
  });

  it('returns the raw SVG as text only when explicitly requested', () => {
    const handlers = createUtilityToolHandlers({ recentChanges: [] });
    const view: any = handlers.render_chart({ ...barArgs, includeSvg: true });
    expect(view.content).toHaveLength(2);
    expect(view.content[1].type).toBe('text');
    expect(view.content[1].text).toContain('<svg');
  });

  it('rejects a result that exceeds the size cap instead of dumping it into the context', () => {
    const handlers = createUtilityToolHandlers({ recentChanges: [] });
    // At the input caps (1000 points, 200-char labels) `renderBar` emits one <text>
    // per point — hundreds of kilobytes of markup, previously returned twice.
    const data = Array.from({ length: 1000 }, (_, i) => ({
      label: `${'L'.repeat(200)}-${i}`,
      value: i,
    }));
    const view: any = handlers.render_chart({ type: 'bar', data });
    expect(view.isError).toBe(true);
    expect(JSON.parse(view.content[0].text).error).toMatch(/exceeds the limit of \d+KB/);
  });

  it('logs the full renderer error server-side and relays only a bounded message', () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const handlers = createUtilityToolHandlers({ recentChanges: [], logger });
    // An unknown `type` reaches `renderChartSvg`'s default branch, which interpolates
    // it into the thrown message; an oversized one must not become an oversized
    // conversation message (findings H4/L6).
    const view: any = handlers.render_chart({ type: 'z'.repeat(5_000) });
    expect(view.isError).toBe(true);
    const relayed = JSON.parse(view.content[0].text).error as string;
    expect(relayed).toMatch(/Unknown chart type/);
    expect(relayed.length).toBeLessThan(1_000);
    expect(logger.error).toHaveBeenCalled();
  });

  /**
   * Finding M2: this was the only relay site in the package that never consulted
   * `isPackageAuthoredError` — it assumed every throw reaching it was one the
   * renderer authored, an assumption nothing enforced. The renderer's own throws are
   * branded and still reach the model in full; anything else is redacted like every
   * other host-boundary failure.
   */
  it('redacts an UNBRANDED error instead of relaying its text verbatim', () => {
    const logger = { log: vi.fn(), error: vi.fn() };
    const handlers = createUtilityToolHandlers({ recentChanges: [], logger });
    // A `colors` getter that throws stands in for any unexpected failure inside the
    // renderer — the class the old unconditional relay would have echoed verbatim.
    const hostile = {
      type: 'bar',
      data: [{ label: 'a', value: 1 }],
      get colors(): string[] {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432 (password=hunter2)');
      },
    };
    const view: any = handlers.render_chart(hostile as never);
    expect(view.isError).toBe(true);
    const relayed = JSON.parse(view.content[0].text).error as string;
    expect(relayed).not.toContain('hunter2');
    expect(relayed).not.toContain('10.0.0.5');
    expect(relayed).toMatch(/reference "mcp-/);
    // The detail is still available to an operator, server-side.
    expect(String(logger.error.mock.calls[0][0])).toContain('hunter2');
  });

  it('still relays the renderer BRANDED array-cap guidance the model needs', () => {
    const handlers = createUtilityToolHandlers({ recentChanges: [] });
    const data = Array.from({ length: 1001 }, (_, i) => ({ label: `L${i}`, value: i }));
    const view: any = handlers.render_chart({ type: 'bar', data });
    expect(view.isError).toBe(true);
    const relayed = JSON.parse(view.content[0].text).error as string;
    expect(relayed).toMatch(/exceeds the limit of 1000/);
    expect(relayed).toMatch(/Split the request/);
    expect(relayed).not.toMatch(/reference "mcp-/);
  });
});
