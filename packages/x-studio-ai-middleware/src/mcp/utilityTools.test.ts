/**
 * Unit tests for `mcp/utilityTools.ts`'s handler factory, exercised directly
 * (rather than through the full `buildStudioMcpServer` composition root).
 *
 * Focuses on the `get_recent_changes` response bound (finding ai-mw 3.4): the
 * handler must cap how much of the (untrusted-sized) mutation log it serializes
 * into a single tool response, regardless of how large the injected array is.
 * `render_chart`'s own hardening is covered by `../chartRenderer.test.ts`.
 */

import { describe, expect, it } from 'vitest';
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
