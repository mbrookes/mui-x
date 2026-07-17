/**
 * The two data-source-independent MCP tool handlers: `render_chart` (pure SVG
 * rendering) and `get_recent_changes` (session-scoped mutation log).
 *
 * Titles/annotations/list-definitions for these two tools stay in
 * `./toolMetadata` (`EXTRA_TOOL_DEFINITIONS` / `TOOL_TITLES` / `TOOL_ANNOTATIONS`)
 * rather than moving here, since `toolMetadata.ts` is imported by `mcp.ts` and
 * relocating its entries would force an import-path change there.
 */

import type { ChartRendererInput } from '../chartRenderer';
import { renderChartSvg } from '../chartRenderer';
import type { StudioAIRecentMutation } from '../models/aiTypes';
import { errorResult, jsonResult, type ToolHandler } from './helpers';

/** Dependencies needed by the utility tool handlers. */
export interface UtilityToolDeps {
  /** Session-scoped mutation log surfaced by `get_recent_changes`. */
  recentChanges: StudioAIRecentMutation[];
}

/**
 * Hard upper bound on the number of mutation-log entries `get_recent_changes`
 * will ever serialize into a single tool response — and the default when no
 * `limit` argument is supplied. Applied independently of however large the
 * injected `recentChanges` array happens to be: the handler must not trust the
 * caller to have pre-bounded it (`mcp.ts` currently caps the buffer at 20, but
 * other call sites inject their own arrays and a host could raise that cap).
 * An unbounded response leaks a large amount of historical state into the model
 * context — a cost/exfiltration risk under prompt injection — and can blow past
 * reasonable tool-response size limits. Mirrors the `query_data_source` limit
 * clamp (see `queryTools.ts`).
 */
const MAX_RECENT_CHANGES_RESPONSE = 50;

/** Build the `get_recent_changes` and `render_chart` handlers. */
export function createUtilityToolHandlers(deps: UtilityToolDeps): Record<string, ToolHandler> {
  const { recentChanges } = deps;

  return {
    // ── get_recent_changes — session-scoped mutation log ────────────────
    // Returns the most-recent slice of the log (oldest first), matching the
    // direct-return shape of the other read-only dispatch-table tools (e.g.
    // `describe_data_source`); only the mutation-committing tool uses the
    // `{ output, mutation }` envelope. The response is always bounded — see
    // MAX_RECENT_CHANGES_RESPONSE — so an oversized log can't be dumped whole.
    get_recent_changes: (args) => {
      // Clamp a caller-supplied `limit` to a positive integer within
      // [1, MAX_RECENT_CHANGES_RESPONSE]; a falsy/`NaN`/absent value falls back
      // to the hard cap. Mirrors the `query_data_source` limit clamp (T2-6): a
      // negative/`NaN`/huge value from an untrusted caller must never widen the
      // response beyond the bound.
      const rawLimit = (args as { limit?: unknown } | undefined)?.limit;
      const truncatedLimit = Math.trunc(Number(rawLimit));
      const limit = Math.min(
        Math.max(1, truncatedLimit || MAX_RECENT_CHANGES_RESPONSE),
        MAX_RECENT_CHANGES_RESPONSE,
      );

      const total = recentChanges.length;
      if (total <= limit) {
        // Un-truncated: return the raw array unchanged so read-only consumers
        // still see the exact injected log shape.
        return jsonResult(recentChanges);
      }
      // Keep only the most recent `limit` entries. The log is oldest-first, so
      // the tail slice preserves that order within the window and drops the
      // oldest (least relevant) changes.
      const visible = recentChanges.slice(total - limit);
      const omitted = total - visible.length;
      // Prepend a homogeneous `{ label, at }` sentinel so the model is told the
      // log was truncated and older entries exist, rather than silently seeing a
      // partial history. Same shape as a real entry so the array stays typed.
      return jsonResult([
        {
          label: `…${omitted} older change(s) omitted (showing the ${visible.length} most recent of ${total})`,
          at: new Date().toISOString(),
        },
        ...visible,
      ]);
    },

    // ── render_chart — pure SVG chart rendering ───────────────────────────
    render_chart: (args) => {
      try {
        const chartInput = (args ?? {}) as unknown as ChartRendererInput;
        if (!chartInput.type) {
          return errorResult(
            '`type` is required (bar, line, pie, scatter, donut, or stacked_bar).',
          );
        }
        const svgString = renderChartSvg(chartInput);
        const base64 = Buffer.from(svgString).toString('base64');
        return {
          content: [
            {
              type: 'image' as const,
              data: base64,
              mimeType: 'image/svg+xml',
            },
            {
              type: 'text' as const,
              text: svgString,
            },
          ],
        };
      } catch (err) {
        return errorResult(String(err));
      }
    },
  };
}
