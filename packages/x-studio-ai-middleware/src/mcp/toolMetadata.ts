/**
 * Static tool metadata for the x-studio MCP server — pure data, no logic.
 *
 * Holds the human-readable tool titles, the MCP tool annotations, and the
 * ready-to-list tool definitions for the remaining non-built-in tools
 * (`describe_data_source`, `get_field_values`, `compute_field_stats`,
 * `render_chart`, `get_recent_changes`) that `mcp.ts`'s `tools/list` handler
 * appends. `query_data_source`'s title/annotations/schema are no longer here —
 * it moved to `STUDIO_AI_TOOLS` (`studioAITools.ts`), shared with the chat
 * transport, and both `TOOL_TITLES`/`TOOL_ANNOTATIONS` below pick it up
 * automatically via the registry-derived built-in subset.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { STUDIO_AI_TOOL_REGISTRY, type StudioAIToolFacts } from '@mui/x-studio-schema';
import type { StudioAIToolName } from '../models/aiTypes';
import type { McpExtraToolName } from './types';

/** Union of every tool name `TOOL_TITLES`/`TOOL_ANNOTATIONS` must cover. */
type McpToolName = StudioAIToolName | McpExtraToolName;

/**
 * Hand-written titles for the MCP-only "extra" tools — `McpExtraToolName`
 * members (data-query tools, `render_chart`, `get_recent_changes`) that are
 * never `STUDIO_AI_TOOLS` members and therefore have no `STUDIO_AI_TOOL_REGISTRY`
 * entry to derive from.
 */
const EXTRA_TOOL_TITLES: Record<McpExtraToolName, string> = {
  describe_data_source: 'Describe data source',
  get_field_values: 'Get field values',
  compute_field_stats: 'Compute field stats',
  render_chart: 'Render chart',
  get_recent_changes: 'Get recent changes',
};

/** `TOOL_TITLES` entries for every `STUDIO_AI_TOOLS` member, read straight off the registry. */
function builtInToolTitles(): Record<StudioAIToolName, string> {
  const titles = {} as Record<StudioAIToolName, string>;
  for (const name of Object.keys(STUDIO_AI_TOOL_REGISTRY) as StudioAIToolName[]) {
    titles[name] = STUDIO_AI_TOOL_REGISTRY[name].title;
  }
  return titles;
}

/**
 * Human-readable display titles for MCP tools (shown in Claude Desktop's
 * permission editor).
 *
 * Typed against `McpToolName` (rather than a plain `Record<string, string>`) so
 * a missing entry for a real tool, or a phantom entry for a tool that doesn't
 * exist, is a compile error — mirroring the tool-name drift guard in
 * `studioAITools.ts`. This caught two real bugs: `list_pages` was missing here
 * (MCP `tools/list` emitted `title: undefined` for it) while `get_current_date`
 * was a phantom entry for a tool that exists nowhere in the package. The
 * `STUDIO_AI_TOOLS`-member subset (`StudioAIToolName`) is now derived from
 * `STUDIO_AI_TOOL_REGISTRY` — the shared source of truth for tool titles — so
 * it can no longer drift from the registry independently of that guard.
 */
export const TOOL_TITLES: Record<McpToolName, string> = {
  ...builtInToolTitles(),
  ...EXTRA_TOOL_TITLES,
};

/**
 * Builds the MCP `ToolAnnotations` for one `STUDIO_AI_TOOL_REGISTRY` entry.
 * Key insertion order mirrors the original hand-written entries exactly
 * (`readOnlyHint?` → `destructiveHint` → `idempotentHint?` → `openWorldHint`)
 * so the annotations objects — and thus the MCP `tools/list` output — stay
 * byte-identical to the pre-registry version.
 *
 * `destructiveHint` prefers `mcpDestructiveOverride` when the registry entry
 * sets one (e.g. `remove_page_filter`/`remove_widget_filter` are marked
 * destructive here so MCP clients — which surface `destructiveHint` in their own
 * confirmation UI — flag the permanent deletion; the composed chat default policy
 * now ALSO gates these via the effects-aware `removedFilterIds` check, so the
 * override no longer implies the op is chat-unguarded), else falls back to
 * `destructive`.
 */
function annotationsFromFacts(facts: StudioAIToolFacts): ToolAnnotations {
  const annotations: ToolAnnotations = {};
  if (facts.readOnly) {
    annotations.readOnlyHint = true;
  }
  annotations.destructiveHint = facts.mcpDestructiveOverride ?? facts.destructive;
  if (facts.idempotent) {
    annotations.idempotentHint = true;
  }
  annotations.openWorldHint = facts.openWorld ?? false;
  return annotations;
}

/** `TOOL_ANNOTATIONS` entries for every `STUDIO_AI_TOOLS` member, derived from the registry. */
function builtInToolAnnotations(): Record<StudioAIToolName, ToolAnnotations> {
  const annotations = {} as Record<StudioAIToolName, ToolAnnotations>;
  for (const name of Object.keys(STUDIO_AI_TOOL_REGISTRY) as StudioAIToolName[]) {
    annotations[name] = annotationsFromFacts(STUDIO_AI_TOOL_REGISTRY[name]);
  }
  return annotations;
}

/**
 * Hand-written annotations for the MCP-only "extra" tools (no
 * `STUDIO_AI_TOOL_REGISTRY` entry — see `EXTRA_TOOL_TITLES`).
 */
const EXTRA_TOOL_ANNOTATIONS: Record<McpExtraToolName, ToolAnnotations> = {
  render_chart: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  get_recent_changes: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  describe_data_source: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  get_field_values: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  compute_field_stats: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/**
 * MCP tool annotations for each tool name (both built-in `STUDIO_AI_TOOLS`
 * members, derived from `STUDIO_AI_TOOL_REGISTRY`, and the dynamically added
 * extra tools). Previously every entry here was hand-written; the
 * `STUDIO_AI_TOOLS`-member subset is now `annotationsFromFacts` applied to the
 * shared registry, so it can't drift from `DESTRUCTIVE_TOOLS`
 * (`studioAITools.ts`) or the chat approval gate (`agenticLoop.ts`) the way
 * `apply_bulk_update` once did.
 */
export const TOOL_ANNOTATIONS: Record<McpToolName, ToolAnnotations> = {
  ...builtInToolAnnotations(),
  ...EXTRA_TOOL_ANNOTATIONS,
};

/** Shape of a tool definition entry returned by the `tools/list` handler. */
export interface McpToolDefinition {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
}

/**
 * Tool definitions registered only when `options.data` is provided — the
 * read-only data-access tools. `query_data_source` is NOT here: it's now a
 * `STUDIO_AI_TOOLS` member (shared with the chat transport), advertised via
 * `mcp.ts`'s `toolsToRegister`/`builtinTools` path instead.
 */
export const DATA_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'describe_data_source',
    title: TOOL_TITLES.describe_data_source,
    description:
      'Returns the schema (field definitions), total row count, up to 10 sample rows, and basic ' +
      'per-field statistics for a data source. Call this first when you need to understand a ' +
      'source before querying — it gives you the field IDs, types, and scale in one request.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Data source ID from the dashboard state (e.g. "source-orders").',
        },
      },
      required: ['sourceId'],
    } as Record<string, unknown>,
    annotations: TOOL_ANNOTATIONS.describe_data_source,
  },
  {
    name: 'get_field_values',
    title: TOOL_TITLES.get_field_values,
    description:
      'Returns the distinct values and their occurrence counts for a specific field. ' +
      'Use this to understand categorical fields before filtering or grouping ' +
      '(e.g. "what statuses exist?", "which regions are represented?").',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Data source ID from the dashboard state.',
        },
        fieldId: {
          type: 'string',
          description: 'Field ID (column name) to get distinct values for.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of distinct values to return. Default 50, capped at 200.',
          default: 50,
        },
      },
      required: ['sourceId', 'fieldId'],
    } as Record<string, unknown>,
    annotations: TOOL_ANNOTATIONS.get_field_values,
  },
  {
    name: 'compute_field_stats',
    title: TOOL_TITLES.compute_field_stats,
    description:
      'Computes accurate min, max, average, sum, and count for one or more numeric fields ' +
      'across the full dataset. More reliable than summarise_page for large tables because ' +
      'it runs a DB-tier aggregation rather than sampling.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: {
          type: 'string',
          description: 'Data source ID from the dashboard state.',
        },
        fields: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field IDs (column names) to compute statistics for.',
        },
      },
      required: ['sourceId', 'fields'],
    } as Record<string, unknown>,
    annotations: TOOL_ANNOTATIONS.compute_field_stats,
  },
];

/**
 * Tool definitions registered unconditionally (in addition to the built-in
 * `STUDIO_AI_TOOLS`): the SVG chart renderer and the session change log.
 */
export const EXTRA_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'render_chart',
    title: TOOL_TITLES.render_chart,
    description:
      'Render an arbitrary chart as a standalone SVG image. ' +
      'Useful for visualising query results, comparisons, or any data the model has available. ' +
      'Supported types: "bar", "line", "pie", "scatter", "donut", "stacked_bar". ' +
      'For bar/pie/donut charts provide `data` as an array of { label, value } objects. ' +
      'For single-series line charts use `data`; for multi-series lines/stacked_bar use `xLabels` + `series`. ' +
      'For scatter charts use `xLabels` (numeric x values as strings) with one or more `series` of ' +
      'y-values (each series is plotted as its own set of points against those x values), or provide ' +
      '`data` as { label, value } points where a numeric `label` is the x position and `value` is the y. ' +
      'The SVG is returned as a base64-encoded image/svg+xml content item.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['bar', 'line', 'pie', 'scatter', 'donut', 'stacked_bar'],
          description: 'Chart type.',
        },
        title: { type: 'string', description: 'Optional chart title.' },
        data: {
          type: 'array',
          description: 'Data points for bar, pie, donut, or single-series line/scatter charts.',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'number' },
            },
            required: ['label', 'value'],
          },
        },
        xLabels: {
          type: 'array',
          items: { type: 'string' },
          description: 'X-axis labels for multi-series line, stacked_bar, and scatter charts.',
        },
        series: {
          type: 'array',
          description: 'Named series for multi-series line, stacked_bar, and scatter charts.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['name', 'values'],
          },
        },
        width: { type: 'number', description: 'SVG width in pixels. Default: 600.' },
        height: { type: 'number', description: 'SVG height in pixels. Default: 400.' },
        colors: {
          type: 'array',
          items: { type: 'string' },
          description: 'Custom hex colour palette. Cycles if more series than colours.',
        },
      },
      required: ['type'],
    } as Record<string, unknown>,
    annotations: TOOL_ANNOTATIONS.render_chart,
  },
  {
    name: 'get_recent_changes',
    title: TOOL_TITLES.get_recent_changes,
    description:
      'Returns a compact, time-ordered log of the most recent changes made to the dashboard ' +
      'in this session (e.g. "addWidget:chart:w1", "addFilter:region"). ' +
      'Use this to understand what was just changed before deciding what to do next. ' +
      'Only reflects changes made through this MCP session — not edits made elsewhere.',
    inputSchema: {
      type: 'object',
      properties: {},
    } as Record<string, unknown>,
    annotations: TOOL_ANNOTATIONS.get_recent_changes,
  },
];
