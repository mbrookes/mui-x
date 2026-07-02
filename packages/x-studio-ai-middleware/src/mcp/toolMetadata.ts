/**
 * Static tool metadata for the x-studio MCP server — pure data, no logic.
 *
 * Holds the human-readable tool titles, the MCP tool annotations, the
 * `query_data_source` JSON schema, and the ready-to-list tool definitions for
 * the non-built-in tools (data tools + `render_chart` + `get_recent_changes`)
 * that `mcp.ts`'s `tools/list` handler appends.
 */

import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

/** Human-readable display titles for MCP tools (shown in Claude Desktop's permission editor). */
export const TOOL_TITLES: Record<string, string> = {
  get_dashboard_state: 'Get dashboard state',
  set_dashboard_title: 'Set dashboard title',
  add_page: 'Add page',
  rename_page: 'Rename page',
  remove_page: 'Remove page',
  set_active_page: 'Switch page',
  add_widget: 'Add widget',
  update_widget: 'Update widget',
  remove_widget: 'Remove widget',
  set_widget_layout: 'Set widget layout',
  set_widget_width: 'Set widget width',
  set_widget_forecast: 'Set widget forecast',
  add_page_filter: 'Add page filter',
  remove_page_filter: 'Remove page filter',
  add_widget_filter: 'Add widget filter',
  remove_widget_filter: 'Remove widget filter',
  summarise_page: 'Summarise page',
  apply_bulk_update: 'Apply bulk update',
  rename_thread: 'Rename thread',
  execute_query: 'Execute query',
  get_current_date: 'Get current date',
  query_data_source: 'Query data source',
  describe_data_source: 'Describe data source',
  get_field_values: 'Get field values',
  compute_field_stats: 'Compute field stats',
  render_chart: 'Render chart',
  get_recent_changes: 'Get recent changes',
};

/** MCP tool annotations for each tool name (both built-in and dynamically added tools). */
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations> = {
  // Read-only — never modifies state.
  get_dashboard_state: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  list_pages: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
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
  query_data_source: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
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
  summarise_page: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  execute_query: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  // Destructive — permanently deletes an entity.
  remove_widget: { destructiveHint: true, openWorldHint: false },
  remove_page: { destructiveHint: true, openWorldHint: false },
  remove_page_filter: { destructiveHint: true, openWorldHint: false },
  remove_widget_filter: { destructiveHint: true, openWorldHint: false },
  // Idempotent setters — applying the same args twice has no additional effect.
  set_dashboard_title: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_widget_layout: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_widget_width: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  rename_page: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_active_page: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  update_widget: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  apply_bulk_update: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  rename_thread: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  set_widget_forecast: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
  // Additive — each call creates a new entity; not idempotent.
  add_page: { destructiveHint: false, openWorldHint: false },
  add_widget: { destructiveHint: false, openWorldHint: false },
  add_page_filter: { destructiveHint: false, openWorldHint: false },
  add_widget_filter: { destructiveHint: false, openWorldHint: false },
};

/** JSON Schema for the `query_data_source` tool input. */
export const QUERY_DATA_SOURCE_SCHEMA = {
  type: 'object',
  properties: {
    sourceId: {
      type: 'string',
      description:
        'The data source ID from the dashboard state (e.g. "source-orders", "source-crm-deals"). ' +
        'Read the studio://dashboard/state resource to discover available sources and their field IDs.',
    },
    columns: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Field IDs to return. Omit to return all non-hidden fields. ' +
        'Field IDs exactly match the column names in the database (camelCase).',
    },
    filters: {
      type: 'array',
      description:
        'Structured WHERE predicates. Each filter narrows the result set. ' +
        'Do NOT use raw SQL — use these structured operators only.',
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Field ID (column name) to filter on.' },
          operator: {
            type: 'string',
            enum: ['eq', 'neq', 'in', 'lt', 'lte', 'gt', 'gte', 'like', 'between'],
            description:
              'eq=equal, neq=not equal, in=one of array, lt/lte/gt/gte=numeric comparison, ' +
              'like=substring (%value%), between=inclusive range (supply value + value2).',
          },
          value: { description: 'Filter value. For between, this is the lower bound.' },
          value2: { description: 'Upper bound for the between operator.' },
        },
        required: ['field', 'operator', 'value'],
      },
    },
    aggregations: {
      type: 'array',
      description:
        'Aggregation functions applied via GROUP BY. ' +
        'Non-aggregated columns in `columns` become the GROUP BY list. ' +
        'Examples: count orders per status, sum revenue per category.',
      items: {
        type: 'object',
        properties: {
          column: { type: 'string', description: 'Field ID to aggregate.' },
          func: {
            type: 'string',
            enum: ['sum', 'avg', 'count', 'min', 'max'],
            description:
              'Use count for counting rows, sum for totals, avg for averages, min/max for extremes.',
          },
          alias: {
            type: 'string',
            description: 'Output key for this aggregated value in returned rows.',
          },
        },
        required: ['column', 'func', 'alias'],
      },
    },
    having: {
      type: 'array',
      description:
        'Post-aggregation filters (HAVING clause). Each entry filters on an aggregation alias. ' +
        'Example: to show only categories with total revenue > 10 000, combine ' +
        '`aggregations: [{ column: "revenue", func: "sum", alias: "total_revenue" }]` with ' +
        '`having: [{ alias: "total_revenue", operator: "gt", value: 10000 }]`.',
      items: {
        type: 'object',
        properties: {
          alias: {
            type: 'string',
            description:
              'Aggregation alias to filter on (must match an entry in aggregations[].alias).',
          },
          operator: {
            type: 'string',
            enum: ['eq', 'gt', 'lt', 'gte', 'lte'],
            description: 'eq=equal, gt=greater than, lt=less than, gte/lte=inclusive.',
          },
          value: { type: 'number', description: 'Numeric threshold.' },
        },
        required: ['alias', 'operator', 'value'],
      },
    },
    orderBy: {
      type: 'array',
      description: 'Sort the result rows. Apply after aggregations when using GROUP BY.',
      items: {
        type: 'object',
        properties: {
          column: {
            type: 'string',
            description: 'Column name or aggregation alias to sort by.',
          },
          direction: { type: 'string', enum: ['asc', 'desc'] },
        },
        required: ['column', 'direction'],
      },
    },
    limit: {
      type: 'number',
      description:
        'Maximum rows to return. Default 1000. Use a smaller value for exploration; ' +
        'use aggregations instead of high limits for analytical summaries.',
      default: 1000,
    },
    offset: {
      type: 'number',
      description:
        'Number of rows to skip before returning results. Use with limit for pagination. Default 0.',
      default: 0,
    },
  },
  required: ['sourceId'],
} as const;

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
 * read-only data-access tools.
 */
export const DATA_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: 'query_data_source',
    title: TOOL_TITLES.query_data_source,
    description:
      'Query a data source (database table) with structured filters, aggregations, and sorting. ' +
      'Use this to retrieve data rows, compute aggregates (totals, averages, counts by group), ' +
      'or explore the underlying data before configuring widgets. ' +
      'Supports HAVING predicates to filter on aggregation results (e.g. "categories where revenue > $10K"). ' +
      'Results are read-only — this tool never modifies data. ' +
      'Tip: use the studio://dashboard/state resource to discover available sourceIds and field names.',
    inputSchema: QUERY_DATA_SOURCE_SCHEMA as unknown as Record<string, unknown>,
    annotations: TOOL_ANNOTATIONS.query_data_source,
  },
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
          description: 'Maximum number of distinct values to return. Default 50.',
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
      'For scatter charts use `xLabels` (x values as strings) and a single series of y-values, or supply ' +
      'two series where series[0] = x-values and series[1] = y-values. ' +
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
