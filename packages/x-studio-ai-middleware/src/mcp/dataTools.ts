/**
 * Composition façade over the split-out data-tool modules for the x-studio
 * MCP server.
 *
 * This file used to hold every data-query, chart-render, and page-summary
 * handler in one ~575-line module. It is now a thin re-export layer over:
 *
 * - `./queryTools` — `resolveSource` + the four data-query handlers
 *   (`query_data_source`, `describe_data_source`, `get_field_values`,
 *   `compute_field_stats`)
 * - `./utilityTools` — the two data-source-independent handlers
 *   (`render_chart`, `get_recent_changes`)
 * - `./summarisePage` — `createSummarisePageHandler` and its anomaly-detection
 *   helpers
 *
 * `createDataToolHandlers` still returns all six handler keys in one record —
 * `mcp.ts` spreads the whole thing into its `tools/call` dispatch table — and
 * `DataToolDeps`'s shape is unchanged, so neither `mcp.ts` nor `agenticLoop.ts`
 * needs to change for this split.
 */

import type { StudioAIRecentMutation } from '../models/aiTypes';
import type { ToolHandler } from './helpers';
import type { StudioMcpData, StudioMcpLogger, StudioStateBox } from './types';
import { createQueryToolHandlers } from './queryTools';
import { createUtilityToolHandlers } from './utilityTools';

export { resolveSource } from './queryTools';
export { createSummarisePageHandler } from './summarisePage';

/** Dependencies shared by the data-query and utility tool handlers. */
export interface DataToolDeps {
  stateBox: StudioStateBox;
  /** Data-access configuration; when absent, the data tools return descriptive errors. */
  data?: StudioMcpData;
  /** Hard upper bound applied to the `query_data_source` `limit`. */
  maxQueryRows: number;
  /** Session-scoped mutation log surfaced by `get_recent_changes`. */
  recentChanges: StudioAIRecentMutation[];
  logger?: StudioMcpLogger;
}

/**
 * Build the handlers that are always registered regardless of `data`:
 * `get_recent_changes`, `render_chart`, and the data tools (which internally
 * return a descriptive error when `data` is not configured).
 */
export function createDataToolHandlers(deps: DataToolDeps): Record<string, ToolHandler> {
  const { stateBox, data, maxQueryRows, recentChanges } = deps;

  return {
    ...createUtilityToolHandlers({ recentChanges }),
    ...createQueryToolHandlers({ stateBox, data, maxQueryRows }),
  };
}
