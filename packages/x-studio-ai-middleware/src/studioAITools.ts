/**
 * Canonical description of widget config keys for all widget kinds.
 * Shared between the chat tool schema (add_widget) and the createWidget system prompt
 * so that both paths support the same full set of widget types.
 */
export const WIDGET_CONFIG_DESCRIPTION =
  'Widget configuration. Keys depend on the widget kind:\n' +
  // Chart keys
  'chart: chartType (bar|line|area|pie|donut|scatter|bar-stacked|bar-100|area-stacked|area-100|heatmap|funnel|gantt|gauge|mixed), xField, yField, yAggregation (sum|count|avg|min|max — use "count" when yField is a string/boolean; default "sum"), seriesField;\n' +
  '  barLayout: "horizontal" — use for >5 categories, long names, or ranking charts; do NOT use for time-series;\n' +
  '  chartSortBy: "value"|"category", chartSortDirection: "asc"|"desc" — for ranked bar charts;\n' +
  '  xGroupBy: "day"|"week"|"month"|"quarter"|"year" — required when xField is date/datetime;\n' +
  '  scatterColorField: categorical field to colour scatter points; scatterSizeField: numeric field for bubble size (scatter→bubble);\n' +
  '  pieArcLabel: "value"|"percent"|"none" — labels shown on pie/donut arcs;\n' +
  '  heatColorScheme: "primary"|"success"|"warning"|"error" — colour palette for heatmap;\n' +
  '  crossFilterMode: "cross-highlight"|"cross-filter"|"none" — how widget responds to cross-filter events (default: "cross-highlight");\n' +
  '  crossFilterField: field ID to emit when a bar/point is clicked (default: xField);\n' +
  '  yField2: second numeric field for a secondary scatter axis or additional bar series;\n' +
  // Heatmap / funnel / gantt / gauge / mixed
  'heatmap: xField (columns), heatYField (rows), yField (intensity), yAggregation, heatColorScheme;\n' +
  'funnel: xField (stages), yField (value), yAggregation (use "count" when yField is string);\n' +
  'gantt: ganttLabelField, ganttStartField (date), ganttEndField (date), ganttColorField (optional);\n' +
  'gauge: yField, yAggregation, gaugeMin (default 0), gaugeMax;\n' +
  'mixed: ySeries (array of {fieldId, label, type: bar|line, yAggregation}), dualYAxis (boolean);\n' +
  // KPI
  'kpi: kpiValueField, kpiAggregation (sum|avg|count|min|max), kpiSparkline (boolean), kpiSparklinePlotType (line|bar|gauge), kpiSparklineGaugeMin, kpiSparklineGaugeMax, kpiSparklineCumulative (boolean), kpiSparklineGranularity ("day"|"week"|"month"|"quarter"|"year"),\n' +
  '  kpiTrend (boolean), kpiTrendComparison ("previous-period"|"previous-calendar-period"|"year-over-year"), kpiTrendInvert (boolean — true if lower is better),\n' +
  '  kpiTarget (number), kpiTargetRef (StudioMetricRef ID);\n' +
  // Grid
  'grid: columns (array of field IDs), gridSortField (field ID), gridSortDirection ("asc"|"desc"), gridGroupByField (categorical field to group rows);\n' +
  // Filter
  'filter: filterWidgetType (date-range|multi-select|toggle|slider), filterWidgetField;\n' +
  // Pivot
  'pivot: pivotRowField, pivotColField, pivotValueField, pivotAggregation (sum|count|avg|min|max), pivotShowTotals (boolean);\n' +
  // Map
  'map: mapCountryField, mapValueField, mapAggregation (sum|count|avg|min|max), mapColorScheme (blues|reds|greens|oranges|purples), mapCrossFilterEmit (boolean — emit cross-filter on country click).\n' +
  'For custom widget kinds registered by the app, pass any config keys the custom widget expects.';

/**
 * OpenAI-compatible tool definitions for the x-studio AI assistant.
 * These are passed in the `tools` field of every chat completion request.
 */
export const STUDIO_AI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_dashboard_state',
      description:
        'Returns a summary of the current dashboard: pages, widgets on the active page, and available data sources. Call this when you need to know what already exists before making changes.',
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
              'Partial widget config to merge in (optional). Same keys as add_widget. Pass only the keys you are changing.',
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
        'Every widget currently on the page must appear in the new layout — use remove_widget first if you want to drop one. ' +
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
        'The canvas uses a 12-column grid; valid values are 3–12. ' +
        'Set `columns` to null to reset the widget to auto-fill (equal share of row width). ' +
        'Has no effect on a widget that is the only widget in its row (it always fills 100%). ' +
        'Use set_widget_layout first to put multiple widgets on the same row if needed.',
      parameters: {
        type: 'object',
        properties: {
          widgetId: {
            type: 'string',
            description: 'ID of the widget to resize.',
          },
          columns: {
            type: ['integer', 'null'],
            description: 'Column span (3–12) or null to reset to auto-fill.',
            minimum: 3,
            maximum: 12,
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
      description: 'Switches the visible (active) page of the dashboard.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: 'ID of the page to make active.' },
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
      name: 'summarise_page',
      description:
        'Returns a rich data snapshot of every widget on the active dashboard page — ' +
        'including a sampled CSV data excerpt and numeric stats for each widget, and ' +
        'anomaly axis values for chart widgets. ' +
        'Call this when the user asks you to summarise, analyse, or describe the current page. ' +
        'After receiving the result, write an executive summary focused entirely on the DATA and KEY INSIGHTS: ' +
        'lead with the most important finding or trend across the page, then cover notable patterns, ' +
        'significant values, and any anomalies detected in chart data. ' +
        'Reference the relevant widget by name only where it helps the user locate the data being described — ' +
        'do not list widgets structurally or describe the page layout. ' +
        'Write in flowing prose, not bullet lists.',
      parameters: { type: 'object', properties: {}, required: [] },
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
        'Removals do not require confirmation when part of a bulk update. ' +
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
                    'Partial widget config to merge in (optional). Same keys as add_widget.',
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
                kind: { type: 'string', description: 'Widget kind (same values as add_widget).' },
                title: { type: 'string', description: 'Widget title.' },
                sourceId: { type: 'string', description: 'Data source ID (optional).' },
                config: {
                  type: 'object',
                  description: 'Initial widget config (same keys as add_widget).',
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
              'Map of widgetId → column span (3–12). Only include widgets whose width should change.',
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
      name: 'execute_query',
      description:
        'Runs an ad-hoc query against the dashboard data sources and returns the results as JSON. ' +
        'Use this to answer user questions that require fetching actual data — for example ' +
        '"What were the top 5 products by revenue last quarter?" or ' +
        '"How many active customers are there?". ' +
        'Write the query in the same SQL dialect used by the connected data source. ' +
        'Only use this tool when a data resolver has been configured on the server; ' +
        'if unavailable it will return an error.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The SQL (or equivalent query language) query to execute.',
          },
          sourceId: {
            type: 'string',
            description:
              'Optional ID of the specific data source to query. ' +
              'If omitted, the resolver uses its default source.',
          },
        },
        required: ['query'],
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

export type StudioAIToolName =
  | 'get_dashboard_state'
  | 'add_page'
  | 'set_dashboard_title'
  | 'add_widget'
  | 'update_widget'
  | 'remove_widget'
  | 'set_widget_layout'
  | 'set_widget_width'
  | 'rename_page'
  | 'remove_page'
  | 'set_active_page'
  | 'add_page_filter'
  | 'remove_page_filter'
  | 'add_widget_filter'
  | 'remove_widget_filter'
  | 'summarise_page'
  | 'apply_bulk_update'
  | 'rename_thread'
  | 'execute_query'
  | 'set_widget_forecast';
