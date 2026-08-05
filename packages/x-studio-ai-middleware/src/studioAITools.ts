import { STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import type { StudioAIToolName } from './models/aiTypes';
import { buildWidgetConfigDescription } from './widgetConfigMeta';

/**
 * Canonical description of widget config keys for all widget kinds.
 * Generated from `widgetConfigMeta.ts` — edit that file to update what the LLM sees.
 * Shared between the chat tool schema (add_widget) and the createWidget system prompt
 * so that both paths support the same full set of widget types.
 */
export const WIDGET_CONFIG_DESCRIPTION = buildWidgetConfigDescription();

/**
 * OpenAI-compatible tool definitions for the x-studio AI assistant.
 * These are passed in the `tools` field of every chat completion request.
 *
 * INVARIANT 17, structurally — **no description in this array names another tool.**
 *
 * These strings are static: they ship verbatim in `tools` no matter which subset of
 * `STUDIO_AI_TOOLS` a request actually advertises. `allowedTools`, `privateMode`, the
 * `data` config and the `pageSnapshot` gate all narrow that subset, so any description
 * that said "call X first" was wrong for every session that excluded X — the model
 * spends a turn, a tool-call budget unit, and a full conversation re-send discovering
 * the dispatcher's `Unknown tool` rejection. Gating the descriptions per session was
 * the alternative; it was rejected because `agenticLoop.ts` and `mcp.ts` both consume
 * this array directly, so the gate would have to be re-implemented (and kept correct)
 * at two call sites — true by vigilance, exactly the property that failed here.
 *
 * So each description states the CONSTRAINT a valid call must satisfy, or names a
 * prompt REGION ("the dashboard state", `## Layout`), which is true in every session.
 * This is the same rule `resolveSource`'s and `summarise_page`'s error strings already
 * follow. `studioAITools.test.ts` enforces it over every description string, nested
 * parameter descriptions included, so a future cross-reference fails the build rather
 * than shipping.
 */
export const STUDIO_AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_dashboard_state',
      description:
        'Returns the dashboard document (pages, widgets, filters, dashboard settings) plus data-source metadata (id, label, table, fields, and capped distinct values) — never row data. Call this when you need to know what already exists before making changes.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_page',
      description: 'Creates a new dashboard page and sets it as the active page.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title for the new page.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_dashboard_title',
      description: 'Changes the dashboard title.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'New dashboard title.' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_widget',
      description:
        'Adds a new widget to the active dashboard page. Pick sensible defaults from the available data source fields. For custom widget kinds, use the kind identifier shown in the dashboard state.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description:
              'Widget type. Built-in kinds: chart, grid, kpi, text, filter, pivot, map. ' +
              'App-registered custom kinds are listed in the system prompt under "Custom widget kinds" — use the exact kind string shown there.',
          },
          title: { type: 'string', description: 'Widget title.' },
          sourceId: {
            type: 'string',
            description: 'ID of the data source to use (from the dashboard state).',
          },
          config: {
            type: 'object',
            description: WIDGET_CONFIG_DESCRIPTION,
          },
        },
        required: ['kind', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_widget',
      description: 'Updates an existing widget. Pass only the properties you want to change.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'ID of the widget to update.' },
          title: { type: 'string', description: 'New title (optional).' },
          sourceId: { type: 'string', description: 'New data source ID (optional).' },
          config: {
            type: 'object',
            description:
              'Partial widget config to merge in (optional). Takes the same per-kind config ' +
              'keys as a widget creation. Pass only the keys you are changing.',
          },
          unsetFields: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Top-level widget keys to CLEAR back to unset (optional). Use this to void a field ' +
              'rather than setting it — e.g. ["sourceId"] to detach the data source so the user ' +
              'can re-pick one. Clearable keys: sourceId, subtitle, titleMode, subtitleMode. ' +
              'Unknown or non-clearable keys are ignored.',
          },
          unsetConfigKeys: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Config keys to CLEAR back to unset (optional) — e.g. ["xField"] to remove a chart ' +
              'axis field. Only keys currently present on the widget config are cleared; unknown ' +
              'keys are ignored.',
          },
        },
        required: ['widgetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_widget',
      description:
        'Removes a widget from the dashboard. This action requires user confirmation before executing.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'ID of the widget to remove.' },
          widgetTitle: {
            type: 'string',
            description: 'Human-readable title, used in the confirmation message.',
          },
        },
        required: ['widgetId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_widget_layout',
      description:
        'Rearranges widgets on the active page by specifying which widgets share a row. ' +
        'Each entry in `rows` is an array of widget IDs that will appear side-by-side on the same row. ' +
        'Every widget currently on the page must appear in the new layout: an omitted widget ' +
        'is dropped from the layout, so removing a widget from the page is a separate action, ' +
        'never an omission here. ' +
        'The current layout is shown in the system prompt under "## Layout".',
      parameters: {
        type: 'object',
        properties: {
          rows: {
            type: 'array',
            description:
              'New layout as an array of rows. Each row is an array of widget IDs to display side-by-side.',
            items: {
              type: 'array',
              items: { type: 'string', description: 'Widget ID' },
            },
          },
        },
        required: ['rows'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_widget_width',
      description:
        'Sets the column-span (width) of a specific widget on the active page. ' +
        'The canvas uses a 24-column grid; valid values are 6–24. ' +
        'Set `columns` to null to reset the widget to auto-fill (equal share of row width). ' +
        'Has no effect on a widget that is the only widget in its row (it always fills 100%) — ' +
        'a width only becomes visible once its row holds more than one widget, which is a ' +
        'layout change, not a width change.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: {
            type: 'string',
            description: 'ID of the widget to resize.',
          },
          columns: {
            type: ['integer', 'null'],
            description: 'Column span (6–24) or null to reset to auto-fill.',
            minimum: 6,
            maximum: 24,
          },
        },
        required: ['widgetId', 'columns'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_page',
      description: 'Renames an existing dashboard page.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'ID of the page to rename.' },
          title: { type: 'string', description: 'New title for the page.' },
        },
        required: ['pageId', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_page',
      description:
        'Removes a page and all widgets on it from the dashboard. This action requires user confirmation before executing.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'ID of the page to remove.' },
          pageTitle: {
            type: 'string',
            description: 'Human-readable title, used in the confirmation message.',
          },
        },
        required: ['pageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_active_page',
      // Every page-scoped tool resolves its target from `dashboard.activePageId`
      // server-side and REJECTS a widget/filter that lives elsewhere (see
      // `executeToolOnState.ts`). Stating that RULE — rather than enumerating the tools
      // it applies to — still saves the model a wasted error round-trip per cross-page
      // edit, and stays true in a session that advertises only some of them (invariant
      // 17). The page-creation note prevents the opposite waste: a redundant activation
      // of a page that is already active.
      description:
        'Switches the visible (active) page of the dashboard. ' +
        'Every page-scoped operation — adding a widget, changing the layout or a widget ' +
        'width, adding a page filter, applying a bulk update — acts on the ACTIVE page only ' +
        'and rejects a target that lives on another page, so switch first when the page you ' +
        'want to change is not the active one. ' +
        'Creating a page already activates it, so no switch is needed after that.',
      parameters: {
        type: 'object',
        properties: {
          pageId: {
            type: 'string',
            description:
              'ID of the page to make active. Must be the id of a page that already exists — ' +
              'the pages and their ids are described in the dashboard state; never invent one.',
          },
        },
        required: ['pageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_page_filter',
      description:
        'Adds a filter condition scoped to the active page. All widgets on the page that use the specified data source will be filtered.',
      parameters: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description: 'The field ID to filter on (from a data source in the dashboard state).',
          },
          sourceId: {
            type: 'string',
            description: 'The data source ID that owns this field.',
          },
          operator: {
            type: 'string',
            description:
              'Filter operator. One of: equals, not_equals, in, not_in, contains, does_not_contain, starts_with, not_starts_with, ends_with, not_ends_with, is_empty, is_not_empty, greater_than, less_than, greater_than_or_equal, less_than_or_equal, between.',
          },
          value: {
            description:
              'Filter value. For "in"/"not_in" use an array. For "between" use an array of [min, max]. For "is_empty"/"is_not_empty" omit this field.',
          },
          fieldType: {
            type: 'string',
            description:
              'Data type of the field: string, number, date, datetime, or boolean. Helps the UI render the correct filter input.',
          },
        },
        required: ['field', 'sourceId', 'operator'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_page_filter',
      description:
        'Removes a page-scoped filter by its ID. The active filter IDs are listed in the dashboard state.',
      parameters: {
        type: 'object',
        properties: {
          filterId: { type: 'string', description: 'ID of the filter to remove.' },
        },
        required: ['filterId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_widget_filter',
      description:
        'Adds a filter condition scoped to a specific widget. Only that widget is affected.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: {
            type: 'string',
            description: 'ID of the widget to filter.',
          },
          field: {
            type: 'string',
            description: 'The field ID to filter on.',
          },
          sourceId: {
            type: 'string',
            description: 'The data source ID that owns this field.',
          },
          operator: {
            type: 'string',
            description:
              'Filter operator. One of: equals, not_equals, in, not_in, contains, does_not_contain, starts_with, not_starts_with, ends_with, not_ends_with, is_empty, is_not_empty, greater_than, less_than, greater_than_or_equal, less_than_or_equal, between.',
          },
          value: {
            description:
              'Filter value. For "in"/"not_in" use an array. For "between" use an array of [min, max]. For "is_empty"/"is_not_empty" omit this field.',
          },
          fieldType: {
            type: 'string',
            description: 'Data type of the field: string, number, date, datetime, or boolean.',
          },
        },
        required: ['widgetId', 'field', 'sourceId', 'operator'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'remove_widget_filter',
      description:
        'Removes a widget-scoped filter by its ID. The active filter IDs are listed in the dashboard state.',
      parameters: {
        type: 'object',
        properties: {
          filterId: { type: 'string', description: 'ID of the filter to remove.' },
        },
        required: ['filterId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_pages',
      description:
        'Returns all dashboard pages with their id, title, widget count, and widget titles. ' +
        'Use this to discover what pages and widgets exist before navigating, querying, or answering questions about what the dashboard contains. ' +
        'Prefer this over a full dashboard-document read when you only need to know what pages and widgets are present.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarise_page',
      // This description used to advise "otherwise call set_active_page
      // first", and that advice steered the model straight into the one sequence that
      // silently returns the WRONG page: `set_active_page(pageB)` then `summarise_page()`
      // with `pageId` omitted. On the chat transport the row data is a `pageSnapshot`
      // captured ONCE at request time, so activating another page mid-turn cannot make
      // that page's rows available — the snapshot still covers page A. The
      // implementation's own error text says so ("Omit `pageId` … ask the user to open
      // page X", deliberately not reading as "retry"), so the advertised schema
      // contradicted both the code and ARCHITECTURE.md. It now states the same contract
      // they do, and — per invariant 17 — names no tool.
      description:
        'Returns a data snapshot of every widget on a dashboard page — ' +
        'a sampled CSV excerpt and numeric stats (min/max/avg) per widget. ' +
        'Call this when the user asks you to summarise, analyse, or describe a page. ' +
        'Omitting pageId summarises the page this request captured data for (the active ' +
        'page) and is always accepted. A pageId naming a different page is honored only ' +
        'where live data for that page is available server-side; where it is not, the ' +
        'call is rejected and nothing you can do within this turn will load the rows for ' +
        'that page — ask the user to open that page and request the summary again. ' +
        'After receiving the result, write an executive summary of the key insights. ' +
        'IMPORTANT FORMATTING RULES: ' +
        '(1) Begin immediately with the content — no preamble like "Here is a summary", "I will now...", "Based on the data...", etc. ' +
        '(2) Use 2–4 short markdown paragraphs separated by blank lines. ' +
        '(3) **Bold** the most important numbers or findings in each paragraph. ' +
        '(4) Lead with the single most important metric or trend, then cover patterns, notable values, and anomalies. ' +
        '(5) Name a widget only when it helps locate the specific data — never list widgets as a structure.',
      parameters: {
        type: 'object',
        properties: {
          pageId: {
            type: 'string',
            description:
              'ID of the page to summarise. OMIT IT to summarise the page this request ' +
              'captured data for (the active page) — omitting is always accepted and is the ' +
              'right choice unless the user explicitly asked about a different page. ' +
              'A pageId naming a different page is honored only where live data for that ' +
              'page is available server-side; otherwise the call is rejected and the rows for ' +
              'that page cannot be loaded in this turn by any means.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_bulk_update',
      description:
        'Applies multiple coordinated changes to the active dashboard page in a single atomic operation. ' +
        'Use this instead of multiple individual tool calls whenever a prompt requires 3 or more related changes — ' +
        'for example: redesigning a page, changing all charts of a type, or restructuring the layout with config tweaks. ' +
        'All supplied operations are committed together as one undo step. ' +
        'This action requires user confirmation before executing. ' +
        'Omit any key you do not need to change.',
      parameters: {
        type: 'object',
        properties: {
          widgetUpdates: {
            type: 'array',
            description:
              'Partial updates to existing widgets. Only include the fields that should change. ' +
              'Use the widget id from the dashboard state.',
            items: {
              type: 'object',
              properties: {
                widgetId: { type: 'string', description: 'ID of the widget to update.' },
                title: { type: 'string', description: 'New title (optional).' },
                sourceId: { type: 'string', description: 'New data source ID (optional).' },
                config: {
                  type: 'object',
                  description:
                    'Partial widget config to merge in (optional). Same per-kind config keys as a widget creation.',
                },
              },
              required: ['widgetId'],
            },
          },
          widgetRemovals: {
            type: 'array',
            description: 'IDs of widgets to remove from the active page.',
            items: { type: 'string' },
          },
          widgetAdditions: {
            type: 'array',
            description: 'New widgets to add to the active page.',
            items: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  description: 'Widget kind (same values a widget creation accepts).',
                },
                title: { type: 'string', description: 'Widget title.' },
                sourceId: { type: 'string', description: 'Data source ID (optional).' },
                config: {
                  type: 'object',
                  description:
                    'Initial widget config (same per-kind config keys as a widget creation).',
                },
              },
              required: ['kind', 'title'],
            },
          },
          layout: {
            type: 'array',
            description:
              'New widgetRows layout for the active page after additions and removals. ' +
              'Must include every widget that should remain on the page. ' +
              'For widgetAdditions, reference them by their title — the tool will resolve IDs. ' +
              'If omitted, layout is unchanged (new widgets are appended as a new row).',
            items: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          colSpans: {
            type: 'object',
            description:
              'Map of widgetId → column span (6–24). Only include widgets whose width should change.',
            additionalProperties: { type: 'number' },
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_thread',
      description:
        'Rename the current conversation thread to a concise, descriptive title based on the conversation topic. ' +
        'Call this automatically after the user sends their first substantive message in a new thread. ' +
        'The name appears in the thread selector so users can find conversations later. ' +
        'Keep it under 40 characters. Do not ask the user for a name — generate it from context.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              'Concise thread name (max 40 characters). ' +
              'Examples: "Add revenue chart", "Q3 filter by region", "Fix dashboard layout".',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_data_source',
      description:
        'Query a data source (database table) with structured filters, aggregations, and sorting. ' +
        'Use this to answer user questions that require fetching actual data — for example ' +
        '"What were the top 5 products by revenue last quarter?" or ' +
        '"How many active customers are there?". ' +
        'Do NOT write SQL — use the structured filters/aggregations/having fields only. ' +
        'Supports HAVING predicates to filter on aggregation results (e.g. "categories where revenue > $10K"). ' +
        'Results are read-only — this tool never modifies data. ' +
        'Only use this tool when data access has been configured on the server; if unavailable it ' +
        'will return an error. ' +
        'Tip: the valid sourceIds and field IDs are exactly the ones described in the dashboard state.',
      parameters: {
        type: 'object',
        properties: {
          sourceId: {
            type: 'string',
            description:
              'The data source ID from the dashboard state (e.g. "source-orders", "source-crm-deals"). ' +
              'Must be one of the sources described there; do not guess an id.',
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
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_widget_forecast',
      description:
        'Enables or disables a linear trend/forecast overlay on a line or area chart widget. ' +
        'When enabled, the chart extends the x-axis by the given number of periods and overlays ' +
        'a dashed projection line computed from the historical data using linear regression. ' +
        'Optionally renders a shaded confidence band (±1 standard error). ' +
        'Only effective for chartType "line" or "area" with a single y-field.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: { type: 'string', description: 'ID of the chart widget to update.' },
          enabled: {
            type: 'boolean',
            description: 'Whether to show the forecast overlay. Set false to remove it.',
          },
          periods: {
            type: 'number',
            description:
              'Number of future periods to project beyond the last data point. Default 3.',
          },
          showConfidenceBands: {
            type: 'boolean',
            description: 'Whether to draw a shaded confidence band around the trend line.',
          },
        },
        required: ['widgetId', 'enabled'],
      },
    },
  },
] as const;

/**
 * The set of advertised tool names, derived from `STUDIO_AI_TOOLS` (which is
 * `as const`). Kept as runtime data for the drift guard and any consumer that
 * wants to enumerate tool names.
 */
export const STUDIO_AI_TOOL_NAMES = STUDIO_AI_TOOLS.map(
  (tool) => tool.function.name,
) as readonly StudioAIToolName[];

/**
 * The single source of truth for "which tools are destructive" (require
 * explicit user confirmation before executing) — derived from
 * `STUDIO_AI_TOOL_REGISTRY`'s `destructive` fact (`@mui/x-studio-schema`), the
 * shared registry of tool facts.
 *
 * Previously this was a hand-maintained `Set` encoded independently from
 * `mcp/toolMetadata.ts`'s `destructiveHint` values and `agenticLoop.ts`'s chat
 * approval gate, and they had already drifted (`apply_bulk_update` was
 * approval-gated in chat but advertised as safe/idempotent to MCP clients).
 * Now both consumers — and this Set — derive from the same registry entries,
 * so they cannot drift apart: `mcp/toolMetadata.ts`'s `TOOL_ANNOTATIONS`
 * derives its `destructiveHint` defaults straight from the registry, and
 * `agenticLoop.ts`'s private-mode/approval logic imports `DESTRUCTIVE_TOOLS`
 * (this export) directly.
 */
export const DESTRUCTIVE_TOOLS: ReadonlySet<StudioAIToolName> = new Set(
  (Object.keys(STUDIO_AI_TOOL_REGISTRY) as StudioAIToolName[]).filter(
    (name) => STUDIO_AI_TOOL_REGISTRY[name].destructive,
  ),
);

// ── Tool-name drift guard ─────────────────────────────────────────────────────
// `StudioAIToolName` is now DERIVED from `STUDIO_AI_TOOL_REGISTRY`
// (`@mui/x-studio-schema`'s `aiToolRegistry.ts`) rather than a hand-written
// union, but `STUDIO_AI_TOOLS` (the full JSON-schema tool definitions with
// parameters/descriptions) still can't be *derived* from that registry — the
// registry deliberately carries only classification facts, not parameter
// schemas. This assert is therefore still load-bearing: it verifies, at
// compile time and in both directions, that the set of names actually
// advertised in `STUDIO_AI_TOOLS` exactly equals `StudioAIToolName` (i.e. the
// registry's key set). Adding a tool to one without the other (schema without a
// registry entry, or vice versa) is a compile error, so the previously-observed
// drift (`list_pages`, `set_widget_forecast` missing from one side) can't recur.
type AdvertisedToolName = (typeof STUDIO_AI_TOOLS)[number]['function']['name'];
type AssertMutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
// If this errors, `STUDIO_AI_TOOL_REGISTRY`'s keys and the advertised tool names
// (`STUDIO_AI_TOOLS`) have drifted.
const TOOL_NAME_UNION_IN_SYNC: AssertMutuallyAssignable<AdvertisedToolName, StudioAIToolName> =
  true;
void TOOL_NAME_UNION_IN_SYNC;
