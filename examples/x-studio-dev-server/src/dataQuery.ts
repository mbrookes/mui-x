/**
 * Shared `query_data_source` implementation for x-studio-dev-server.
 *
 * Both the chat route (`routes/ai.ts`) and the MCP route (`routes/mcp.ts`) wire
 * the AI `query_data_source` tool through the same `handleBatchQuery` security
 * pipeline used by POST /api/sales-data and POST /api/crm-data — so a raw-SQL
 * escape hatch never exists on either transport.
 */

import type { Knex } from 'knex';
import { handleBatchQuery } from '@mui/x-studio-data-middleware';
import { STUDIO_DATA_WIRE_VERSION } from '@mui/x-studio-schema';
import type { BatchWidgetDescriptor } from '@mui/x-studio-data-middleware';
import type { StudioDataQueryParams } from '@mui/x-studio-ai-middleware';
import type { resolveClaims } from './middleware/claims.js';

export const SALES_SCHEMA_ALLOWLIST = [
  'customers',
  'products',
  'orders',
  'order_items',
  'shipments',
  'shipment_items',
];

export const CRM_SCHEMA_ALLOWLIST = ['contacts', 'deals', 'activities', 'deal_stage_transitions'];

/** Matches a safe SQL identifier so a client-supplied table name can't inject. */
export const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Builds a `data.queryDataSource` callback for `handleAIChat`/`buildStudioMcpServer`.
 * Routes each query to the correct Knex instance based on the source's table name,
 * through `handleBatchQuery` — giving column-allowlist/tenancy enforcement for free.
 */
export function makeQueryDataSource(
  salesDb: Knex,
  crmDb: Knex,
  claims: ReturnType<typeof resolveClaims>,
) {
  return async (params: StudioDataQueryParams) => {
    const isCrm = CRM_SCHEMA_ALLOWLIST.includes(params.tableName);
    const targetDb = isCrm ? crmDb : salesDb;
    const schemaAllowlist = isCrm ? CRM_SCHEMA_ALLOWLIST : SALES_SCHEMA_ALLOWLIST;

    const descriptor: BatchWidgetDescriptor = {
      id: 'query-data-source',
      table: params.tableName,
      ...(params.columns && { columns: params.columns }),
      ...(params.filters && {
        filters: params.filters.map((f) => ({
          column: f.field,
          operator: f.operator,
          // Cast through unknown — StudioDataFilter.value is unknown whereas
          // FilterPredicate.value has a stricter type; the DB middleware validates at runtime.
          value: f.value as unknown,
        })) as BatchWidgetDescriptor['filters'],
      }),
      ...(params.aggregations && {
        aggregations: params.aggregations as BatchWidgetDescriptor['aggregations'],
      }),
      ...(params.orderBy && { orderBy: params.orderBy as BatchWidgetDescriptor['orderBy'] }),
      ...(params.limit !== undefined && { limit: params.limit }),
    };

    const response = await handleBatchQuery(
      // Server-to-server: this call originates HERE, not from a browser client, so it stamps the
      // version of the middleware it was built against. There is no skew to detect on this path,
      // but the field is required and the check is unconditional — a handler that exempted its own
      // in-process callers would be a hole in the very guarantee it exists to make.
      {
        protocolVersion: STUDIO_DATA_WIRE_VERSION,
        pageId: 'query-data-source',
        widgets: [descriptor],
      },
      claims,
      {
        db: targetDb,
        schemaAllowlist,
        // Dev server is single-tenant — no tenant discriminator column.
        tenancy: { mode: 'single-tenant' },
      },
    );

    const result = response.results[0];
    if (result.error) {
      throw new Error(result.error);
    }

    return {
      rows: result.rows,
      rowCount: result.rowCount,
      tier: result.tier,
    };
  };
}
