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

/** Build the `get_recent_changes` and `render_chart` handlers. */
export function createUtilityToolHandlers(deps: UtilityToolDeps): Record<string, ToolHandler> {
  const { recentChanges } = deps;

  return {
    // ── get_recent_changes — session-scoped mutation log ────────────────
    get_recent_changes: () => jsonResult({ output: recentChanges }),

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
