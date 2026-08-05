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
import { errorResult, jsonResult, redactedHostErrorResult, type ToolHandler } from './helpers';
import type { StudioMcpLogger } from './types';

/** Dependencies needed by the utility tool handlers. */
export interface UtilityToolDeps {
  /** Session-scoped mutation log surfaced by `get_recent_changes`. */
  recentChanges: StudioAIRecentMutation[];
  /**
   * Diagnostic logger. `render_chart` logs the FULL renderer error server-side and
   * relays only a bounded excerpt to the model.
   */
  logger?: StudioMcpLogger;
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

/**
 * Hard upper bound on the total serialized size of a single `render_chart` result.
 *
 *
 * `renderBar` emits one `<text>` element per data point and the input caps allow
 * 1000 entries × 200-char labels, so a single render could produce ~800 KB of SVG —
 * all of which entered the model context, since the result previously carried the
 * chart TWICE (a base64 `image` item AND the raw `text` SVG). The duplicate text
 * item is now opt-in (see `includeSvg`), and whatever remains is bounded here:
 * over the cap the call is REJECTED with actionable "render fewer points" guidance
 * rather than silently truncated, since half an SVG is not a chart. Mirrors the
 * reject-don't-truncate stance `MAX_QUERY_ARRAY_LENGTH` (`mcp/queryTools.ts`) takes
 * for model-supplied arrays.
 */
const MAX_RENDER_CHART_RESULT_BYTES = 256 * 1024;

/** Build the `get_recent_changes` and `render_chart` handlers. */
export function createUtilityToolHandlers(deps: UtilityToolDeps): Record<string, ToolHandler> {
  const { recentChanges, logger } = deps;

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
      // to the hard cap. Mirrors the `query_data_source` limit clamp: a
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
        const chartInput = (args ?? {}) as unknown as ChartRendererInput & {
          includeSvg?: unknown;
        };
        if (!chartInput.type) {
          return errorResult(
            '`type` is required (bar, line, pie, scatter, donut, or stacked_bar).',
          );
        }
        const svgString = renderChartSvg(chartInput);
        const base64 = Buffer.from(svgString).toString('base64');
        // The raw SVG used to be returned ALONGSIDE the base64 image
        // unconditionally, so every render entered the model context twice — for a
        // chart at the input caps (1000 points × 200-char labels, one `<text>` per
        // point) that is ~800 KB per call, none of it useful to a model that already
        // has the image. The text copy is now opt-in for the rare caller that wants
        // the markup itself (e.g. to embed it in a page).
        const includeSvg = chartInput.includeSvg === true;
        const resultBytes = base64.length + (includeSvg ? svgString.length : 0);
        if (resultBytes > MAX_RENDER_CHART_RESULT_BYTES) {
          return errorResult(
            `MUI X Studio: render_chart produced a ${Math.round(resultBytes / 1024)}KB result, ` +
              `which exceeds the limit of ${MAX_RENDER_CHART_RESULT_BYTES / 1024}KB. An oversized ` +
              'chart result is not readable by the model and crowds out the rest of the ' +
              'conversation. Render fewer data points or series, shorten the labels, or omit ' +
              '`includeSvg`.',
          );
        }
        return {
          content: [
            {
              type: 'image' as const,
              data: base64,
              mimeType: 'image/svg+xml',
            },
            ...(includeSvg
              ? [
                  {
                    type: 'text' as const,
                    text: svgString,
                  },
                ]
              : []),
          ],
        };
      } catch (err) {
        // `renderChartSvg`'s own throws (unknown chart type, the array-length and
        // total-value caps) are what the model needs in order to correct its call, so
        // unlike the host/DB catch blocks in `queryTools.ts` that text IS relayed — and
        // it is bounded: the unknown-type message interpolates
        // `input.type`, capped and sanitized at the renderer's own choke point.
        //
        // It now routes through `redactedHostErrorResult` like every other
        // relay site in the package instead of relaying `err.message` unconditionally.
        // This was the ONE site that never consulted `isPackageAuthoredError`, so it
        // assumed every throw reaching it was package-authored — an assumption nothing
        // enforced. `renderChartSvg` calls `.toLocaleString()`, `.map`, and array
        // spreads over model-supplied structures; any unexpected `TypeError` (or an
        // error thrown from a future call site) was relayed verbatim, stack message and
        // all. The renderer's own throws are explicitly branded, so they still reach
        // the model in full; anything else is now logged and replaced with a
        // correlation id.
        return redactedHostErrorResult('render_chart', err, logger);
      }
    },
  };
}
