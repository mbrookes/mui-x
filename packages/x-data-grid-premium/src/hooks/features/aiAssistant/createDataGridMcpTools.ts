import type { RefObject } from '@mui/x-internals/types';
import type { GridApiPremium } from '../../../models/gridApiPremium';
import type {
  GridDataQueryInput,
  GridStatisticsInput,
  GridValueDistributionInput,
} from './gridAiAssistantInterfaces';

/** A single MCP-compatible tool descriptor returned by {@link createDataGridMcpTools}. */
export interface DataGridMcpTool {
  /** Stable machine-readable tool name (snake_case). */
  name: string;
  /** Human-readable description shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input object. */
  inputSchema: Record<string, unknown>;
  /** Execute the tool and return a serialisable result. */
  execute: (input: unknown) => Promise<unknown>;
}

/**
 * Converts a DataGrid Premium `apiRef` into a set of MCP-compatible tool descriptors.
 *
 * Use this when building a standalone MCP server that exposes the grid's data to
 * an AI client (Claude Desktop, Cursor, etc.).
 *
 * @example
 * ```ts
 * import { createDataGridMcpTools } from '@mui/x-data-grid-premium';
 * import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
 *
 * const server = new McpServer({ name: 'my-grid', version: '1.0.0' });
 * const tools = createDataGridMcpTools(apiRef);
 * for (const tool of tools) {
 *   server.tool(tool.name, tool.description, tool.inputSchema, (input) => tool.execute(input));
 * }
 * ```
 */
export function createDataGridMcpTools(
  apiRef: RefObject<GridApiPremium | null>,
): DataGridMcpTool[] {
  return [
    {
      name: 'grid_get_context',
      description:
        'Returns the column schema (field names, types, operators, optional statistics) together with ' +
        'total/visible row counts and the currently-active view configuration (filters, sort, grouping, ' +
        'aggregation, pivot state). Call this first to understand what data is available.',
      inputSchema: {
        type: 'object',
        properties: {
          includeStatistics: {
            type: 'boolean',
            description:
              'When true, per-column statistics (min/max/avg/sum for numeric columns; ' +
              'uniqueCount/topValues for categorical columns) are computed and returned. ' +
              'Statistics are sampled from up to 10,000 visible rows.',
          },
        },
      },
      execute: async (input: unknown) => {
        const { includeStatistics = false } = (input as Record<string, unknown>) ?? {};
        return apiRef.current?.aiAssistant.getContext(!!includeStatistics);
      },
    },

    {
      name: 'grid_query_rows',
      description:
        'Queries rows that are currently visible in the grid (i.e. after active filters and sorting) ' +
        'and returns them as plain objects. Use `fields` to limit the columns returned, ' +
        '`limit`/`offset` to paginate through large result sets.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column fields to include. Omit to return all columns.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of rows to return (default: 100).',
          },
          offset: {
            type: 'number',
            description: 'Number of rows to skip before returning results (default: 0).',
          },
        },
      },
      execute: async (input: unknown) =>
        apiRef.current?.aiAssistant.queryRows(input as GridDataQueryInput),
    },

    {
      name: 'grid_get_statistics',
      description:
        'Computes column-level statistics for the currently-visible (filtered) rows. ' +
        'Numeric and date columns return count/nullCount/min/max/avg/sum. ' +
        'String, boolean, and singleSelect columns return count/nullCount/uniqueCount/topValues. ' +
        'Statistics are capped at 10,000 rows for performance.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column fields to compute statistics for. Omit for all columns.',
          },
        },
      },
      execute: async (input: unknown) =>
        apiRef.current?.aiAssistant.getStatistics(input as GridStatisticsInput),
    },

    {
      name: 'grid_get_value_distribution',
      description:
        'Returns the frequency distribution of values in a single column, sorted descending by count. ' +
        'Useful for understanding categorical data, finding the most common values, or detecting outliers.',
      inputSchema: {
        type: 'object',
        properties: {
          field: {
            type: 'string',
            description: 'The column field to analyse.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of top values to return (default: 20).',
          },
        },
        required: ['field'],
      },
      execute: async (input: unknown) =>
        apiRef.current?.aiAssistant.getValueDistribution(input as GridValueDistributionInput),
    },

    {
      name: 'grid_set_filters',
      description:
        'Applies a filter model to the grid. Pass an array of filter items; each item specifies ' +
        'the column field, the operator (e.g. "contains", "equals", ">"), and the value.',
      inputSchema: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Filter items to apply.',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                operator: { type: 'string' },
                value: {},
              },
              required: ['field', 'operator'],
            },
          },
          logicOperator: {
            type: 'string',
            enum: ['and', 'or'],
            description: 'How to combine multiple filter items (default: "and").',
          },
        },
        required: ['items'],
      },
      execute: async (input: unknown) => {
        const { items = [], logicOperator = 'and' } = (input as Record<string, unknown>) ?? {};
        apiRef.current?.setFilterModel({
          items: items as any[],
          logicOperator: logicOperator as any,
        });
      },
    },

    {
      name: 'grid_set_sort',
      description:
        'Sets the sort model of the grid. Each entry specifies a column field and direction.',
      inputSchema: {
        type: 'object',
        properties: {
          sort: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                field: { type: 'string' },
                sort: { type: 'string', enum: ['asc', 'desc'] },
              },
              required: ['field', 'sort'],
            },
          },
        },
        required: ['sort'],
      },
      execute: async (input: unknown) => {
        const { sort = [] } = (input as Record<string, unknown>) ?? {};
        apiRef.current?.setSortModel(sort as any[]);
      },
    },

    {
      name: 'grid_set_grouping',
      description: 'Sets the row grouping model of the grid.',
      inputSchema: {
        type: 'object',
        properties: {
          fields: {
            type: 'array',
            items: { type: 'string' },
            description: 'Column fields to group by, in order.',
          },
        },
        required: ['fields'],
      },
      execute: async (input: unknown) => {
        const { fields = [] } = (input as Record<string, unknown>) ?? {};
        apiRef.current?.setRowGroupingModel(fields as string[]);
      },
    },

    {
      name: 'grid_set_aggregation',
      description:
        'Sets the aggregation model of the grid. Each key is a column field, ' +
        'each value is an aggregation function: "sum", "avg", "min", "max", or "size".',
      inputSchema: {
        type: 'object',
        properties: {
          aggregation: {
            type: 'object',
            additionalProperties: {
              type: 'string',
              enum: ['sum', 'avg', 'min', 'max', 'size'],
            },
          },
        },
        required: ['aggregation'],
      },
      execute: async (input: unknown) => {
        const { aggregation = {} } = (input as Record<string, unknown>) ?? {};
        apiRef.current?.setAggregationModel(aggregation as Record<string, string>);
      },
    },
  ];
}
