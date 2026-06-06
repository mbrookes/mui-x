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
            description:
              'Widget configuration. Keys depend on the widget kind: ' +
              'chart: chartType (bar|line|area|pie|donut|scatter|bar-stacked|bar-100|area-stacked|area-100|heatmap|funnel|gantt|gauge|mixed), xField, yField, yAggregation (sum|count|avg|min|max), seriesField; ' +
              'heatmap: xField (columns), heatYField (rows), yField (intensity), yAggregation; ' +
              'funnel: xField (stages), yField (value), yAggregation; ' +
              'gantt: ganttLabelField, ganttStartField (date), ganttEndField (date), ganttColorField (optional); ' +
              'gauge: yField, yAggregation, gaugeMin (default 0), gaugeMax; ' +
              'mixed: ySeries (array of {fieldId, label, type: bar|line, yAggregation}), dualYAxis (boolean); ' +
              'kpi: kpiValueField, kpiAggregation (sum|avg|count|min|max), kpiSparkline (boolean), kpiSparklinePlotType (line|bar|gauge), kpiSparklineGaugeMin, kpiSparklineGaugeMax; ' +
              'grid: columns (array of field IDs); ' +
              'filter: filterWidgetType (date-range|multi-select|toggle|slider), filterWidgetField; ' +
              'pivot: pivotRowField, pivotColField, pivotValueField, pivotAggregation (sum|count|avg|min|max); ' +
              'map: mapCountryField, mapValueField, mapAggregation (sum|count|avg|min|max), mapColorScheme (blues|reds|greens|oranges|purples). ' +
              'For custom widget kinds registered by the app, pass any config keys the custom widget expects.',
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
            description: 'Partial widget config to merge in (optional). Same keys as add_widget.',
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
  | 'summarise_page';
