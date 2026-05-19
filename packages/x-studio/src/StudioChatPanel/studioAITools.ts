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
        'Adds a new widget to the active dashboard page. Pick sensible defaults from the available data source fields.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['chart', 'grid', 'kpi', 'text', 'filter'],
            description: 'Widget type.',
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
              'chart: chartType (bar|line|area|pie|donut|scatter|bar-stacked|area-stacked), xField, yField, seriesField, yAggregation (sum|count|avg|min|max); ' +
              'kpi: kpiValueField, kpiAggregation (sum|avg|count|min|max), kpiSparkline; ' +
              'grid: columns (array of field IDs); ' +
              'filter: filterWidgetType (date-range|multi-select|toggle|slider), filterWidgetField.',
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
] as const;

export type StudioAIToolName =
  | 'get_dashboard_state'
  | 'add_page'
  | 'set_dashboard_title'
  | 'add_widget'
  | 'update_widget'
  | 'remove_widget'
  | 'set_widget_layout'
  | 'set_widget_width';
