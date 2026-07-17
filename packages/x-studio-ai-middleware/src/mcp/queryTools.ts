/**
 * Data-query tool handlers for the x-studio MCP server:
 * `query_data_source`, `describe_data_source`, `get_field_values`, and
 * `compute_field_stats`.
 *
 * These are exactly the tools that resolve a `sourceId` against
 * `stateBox.current.runtime.dataSources` and then call `data.queryDataSource` —
 * `resolveSource` below is that shared resolution step, exported so it can also
 * be exercised directly in tests.
 */

import { renderChartSvg } from '../chartRenderer';
import { errorResult, jsonResult, type ToolHandler } from './helpers';
import type {
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataHavingPredicate,
  StudioDataOrderBy,
  StudioMcpData,
  StudioStateBox,
} from './types';

/** Dependencies needed by the four data-query tool handlers. */
export interface QueryToolDeps {
  stateBox: StudioStateBox;
  /** Data-access configuration; when absent, the handlers return descriptive errors. */
  data?: StudioMcpData;
  /** Hard upper bound applied to the `query_data_source` `limit`. */
  maxQueryRows: number;
}

/** The shape of a resolved, queryable data source: guaranteed to have a `tableName`. */
type ResolvedSource = StudioStateBox['current']['runtime']['dataSources'][string] & {
  tableName: string;
};

type ResolveSourceResult =
  | { ok: true; source: ResolvedSource; tableName: string }
  | { ok: false; error: ReturnType<typeof errorResult> };

/**
 * Validate `sourceId` against `stateBox.current.runtime.dataSources` *before*
 * building a query. Without this, an unknown/unregistered sourceId would fall
 * straight through as a physical table name and hit the DB, producing a raw
 * driver error (or worse, querying an unintended table) instead of a clear,
 * actionable message.
 *
 * The message is deliberately transport-neutral (no `studio://` resource hint):
 * these handlers are reachable both from MCP `tools/call` and from the chat
 * transport's agentic loop (`agenticLoop.ts`), where an MCP resource URI means
 * nothing. `get_dashboard_state` is a tool available on both transports, so it
 * is named instead as the discovery path.
 *
 * SECURITY NOTE: this only validates that `sourceId` is a KEY the catalog knows
 * about — it does NOT by itself prove the resulting `tableName` is a table the
 * caller should be allowed to query. On the chat transport, the catalog
 * (`stateBox.current.runtime.dataSources`) descends from the client-supplied
 * request body, so a hostile caller can assert a fabricated `dataSources` entry
 * whose `tableName` points at an arbitrary table your DB connection can reach.
 * `allowedTables` (from `StudioAIDataConfig`), when the host configures it, closes
 * that gap: a resolved `tableName` outside the allowlist is rejected here, before
 * any query is built. See `StudioAIDataConfig.allowedTables`'s doc comment for the
 * full trust-boundary rationale.
 */
export function resolveSource(
  stateBox: StudioStateBox,
  sourceId: string,
  allowedTables?: string[],
): ResolveSourceResult {
  // `Object.hasOwn`-guarded lookup (finding T2-1): a prototype-member sourceId
  // (`"constructor"`, `"__proto__"`) would otherwise resolve a truthy inherited value
  // via the prototype chain. Today the `!source.tableName` check below saves this by
  // accident (no prototype member has a `tableName`); the guard makes it explicit and
  // robust rather than incidental.
  const sources = stateBox.current.runtime.dataSources;
  const source = Object.hasOwn(sources, sourceId) ? sources[sourceId] : undefined;
  if (!source || !source.tableName) {
    return {
      ok: false,
      error: errorResult(
        `Unknown data source: "${sourceId}". Call get_dashboard_state or read studio://dashboard/state for available source IDs.`,
      ),
    };
  }
  if (allowedTables && !allowedTables.includes(source.tableName)) {
    return {
      ok: false,
      error: errorResult(
        `Data source "${sourceId}" resolves to table "${source.tableName}", which is not in the ` +
          'server-configured allowedTables list. This request was blocked before reaching the database.',
      ),
    };
  }
  return { ok: true, source: source as ResolvedSource, tableName: source.tableName };
}

/**
 * Build the four data-query tool handlers. Each returns a descriptive error
 * when `data` is not configured, and defers to `resolveSource` for the shared
 * unknown-sourceId check.
 */
export function createQueryToolHandlers(deps: QueryToolDeps): Record<string, ToolHandler> {
  const { stateBox, data, maxQueryRows } = deps;

  return {
    // ── query_data_source — routed separately from state-mutation tools ──
    query_data_source: async (args) => {
      if (!data) {
        return errorResult(
          'query_data_source is not available: this MCP server was started without data access configuration.',
        );
      }

      const { sourceId, columns, filters, aggregations, having, orderBy, limit, offset } = (args ??
        {}) as {
        sourceId: string;
        columns?: string[];
        filters?: StudioDataFilter[];
        aggregations?: StudioDataAggregation[];
        having?: StudioDataHavingPredicate[];
        orderBy?: StudioDataOrderBy[];
        limit?: number;
        offset?: number;
      };

      // Clamp `limit` to a sane, positive integer within [1, maxQueryRows].
      // A model-supplied `limit` is untrusted: a negative value, `NaN` (e.g.
      // from a non-numeric `"all"`), zero, or a fractional value must not
      // reach `data.queryDataSource` unchanged — depending on the host's Knex
      // wiring that produces a raw driver error (`LIMIT NaN`) instead of the
      // actionable, model-recoverable errors this layer otherwise guarantees
      // (T2-6). Falsy (0/NaN) truncated values fall back to `maxQueryRows`,
      // matching the "Default 1000" behavior already documented in the tool's
      // JSON schema.
      const truncatedLimit = Math.trunc(Number(limit));
      const clampedLimit = Math.min(Math.max(1, truncatedLimit || maxQueryRows), maxQueryRows);

      // Clamp `offset` to a non-negative integer, coercing a negative/NaN/
      // non-numeric value to 0 rather than forwarding it untouched (T2-6).
      const truncatedOffset = Math.trunc(Number(offset));
      const clampedOffset =
        Number.isFinite(truncatedOffset) && truncatedOffset > 0 ? truncatedOffset : 0;

      if (!sourceId) {
        return errorResult('sourceId is required');
      }

      const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
      if (!resolved.ok) {
        return resolved.error;
      }
      const { tableName } = resolved;

      try {
        const result = await data.queryDataSource({
          sourceId,
          tableName,
          columns,
          filters,
          aggregations,
          ...(having && having.length > 0 && { having }),
          orderBy,
          limit: clampedLimit,
          ...(offset !== undefined && { offset: clampedOffset }),
        });

        return jsonResult({ sourceId, ...result });
      } catch (err) {
        return errorResult(String(err));
      }
    },

    // ── describe_data_source — schema + row count + sample + stats ────────
    describe_data_source: async (args) => {
      if (!data) {
        return errorResult('Data access not configured.');
      }
      const { sourceId } = (args ?? {}) as { sourceId: string };
      if (!sourceId) {
        return errorResult('sourceId is required');
      }
      const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
      if (!resolved.ok) {
        return resolved.error;
      }
      const { source, tableName } = resolved;
      try {
        const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
        const numericFields = visibleFields.filter((f) => f.type === 'number');

        // Run sample rows and row count in parallel with per-field numeric stats.
        const [sampleResult, ...statsResults] = await Promise.all([
          data.queryDataSource({ sourceId, tableName, limit: 10 }),
          ...numericFields.map((f) =>
            data
              .queryDataSource({
                sourceId,
                tableName,
                aggregations: [
                  { column: f.id, func: 'min', alias: 'min' },
                  { column: f.id, func: 'max', alias: 'max' },
                  { column: f.id, func: 'avg', alias: 'avg' },
                  { column: f.id, func: 'sum', alias: 'sum' },
                ],
                limit: 1,
              })
              .catch(() => null),
          ),
        ]);

        const fieldStats: Record<
          string,
          { min: unknown; max: unknown; avg: unknown; sum: unknown }
        > = {};
        numericFields.forEach((f, i) => {
          const row = statsResults[i]?.rows?.[0];
          if (row) {
            fieldStats[f.id] = {
              min: row.min,
              max: row.max,
              avg: typeof row.avg === 'number' ? Math.round(row.avg * 100) / 100 : row.avg,
              sum: row.sum,
            };
          }
        });

        return jsonResult(
          {
            sourceId,
            label: source.label,
            tableName: source.tableName,
            description: source.aiDescription,
            rowCount: sampleResult.rowCount,
            fields: visibleFields.map((f) => ({
              id: f.id,
              label: f.label,
              type: f.type,
              ...(f.format && { format: f.format }),
              ...(fieldStats[f.id] && { stats: fieldStats[f.id] }),
              ...(source.fieldDistinctValues?.[f.id] && {
                sampleValues: source.fieldDistinctValues[f.id].slice(0, 5),
              }),
            })),
            sampleRows: sampleResult.rows,
          },
          true,
        );
      } catch (err) {
        return errorResult(String(err));
      }
    },

    // ── get_field_values — distinct values + counts ────────────────────────
    get_field_values: async (args) => {
      if (!data) {
        return errorResult('Data access not configured.');
      }
      const {
        sourceId,
        fieldId,
        limit: fieldLimit,
      } = (args ?? {}) as {
        sourceId: string;
        fieldId: string;
        limit?: number;
      };
      if (!sourceId || !fieldId) {
        return errorResult('sourceId and fieldId are required');
      }
      const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
      if (!resolved.ok) {
        return resolved.error;
      }
      const { tableName } = resolved;
      try {
        // Clamp `limit` to a sane, positive integer within [1, 200]. The old
        // `Math.min(fieldLimit ?? 50, 200)` enforced only the UPPER bound, so an
        // untrusted `NaN` (e.g. a non-numeric `"many"`), negative, zero, or
        // fractional value reached the host's `queryDataSource` unclamped
        // (`LIMIT NaN` → a raw driver error, `LIMIT 0` → a silently empty
        // success). Mirror the identical clamp `query_data_source` applies to its
        // own `limit` (T2-6): truncate, floor at 1, and fall back to the default
        // (50) on a falsy/`NaN` truncated value.
        const truncatedFieldLimit = Math.trunc(Number(fieldLimit));
        const clampedFieldLimit = Math.min(Math.max(1, truncatedFieldLimit || 50), 200);
        const result = await data.queryDataSource({
          sourceId,
          tableName,
          columns: [fieldId],
          aggregations: [{ column: fieldId, func: 'count', alias: 'count' }],
          orderBy: [{ column: 'count', direction: 'desc' }],
          limit: clampedFieldLimit,
        });
        type GfvContentItem =
          | { type: 'text'; text: string }
          | { type: 'image'; data: string; mimeType: string };
        const gfvItems: GfvContentItem[] = [
          {
            type: 'text',
            text: JSON.stringify(
              {
                sourceId,
                fieldId,
                totalDistinctValues: result.rowCount,
                values: result.rows,
              },
              null,
              2,
            ),
          },
        ];
        // Auto-render a bar chart of the top values (best-effort).
        const chartData = result.rows.slice(0, 20).map((r) => ({
          label: String(r[fieldId] ?? '(null)'),
          value: Number(r.count ?? 0),
        }));
        if (chartData.length >= 2) {
          try {
            const fieldLabel =
              stateBox.current.runtime.dataSources[sourceId]?.fields?.find((f) => f.id === fieldId)
                ?.label ?? fieldId;
            const svg = renderChartSvg({
              type: 'bar',
              title: `${fieldLabel} distribution`,
              data: chartData,
            });
            gfvItems.push({
              type: 'image',
              data: Buffer.from(svg).toString('base64'),
              mimeType: 'image/svg+xml',
            });
          } catch {
            // Chart rendering is best-effort.
          }
        }
        return { content: gfvItems };
      } catch (err) {
        return errorResult(String(err));
      }
    },

    // ── compute_field_stats — full-table min/max/avg/sum/count ────────────
    compute_field_stats: async (args) => {
      if (!data) {
        return errorResult('Data access not configured.');
      }
      const { sourceId, fields: statFields } = (args ?? {}) as {
        sourceId: string;
        fields: string[];
      };
      if (!sourceId || !statFields || statFields.length === 0) {
        return errorResult('sourceId and fields (non-empty array) are required');
      }
      const resolved = resolveSource(stateBox, sourceId, data.allowedTables);
      if (!resolved.ok) {
        return resolved.error;
      }
      const { tableName } = resolved;
      try {
        const aggregations = statFields.flatMap((f) => [
          { column: f, func: 'min' as const, alias: `${f}__min` },
          { column: f, func: 'max' as const, alias: `${f}__max` },
          { column: f, func: 'avg' as const, alias: `${f}__avg` },
          { column: f, func: 'sum' as const, alias: `${f}__sum` },
          { column: f, func: 'count' as const, alias: `${f}__count` },
        ]);
        const result = await data.queryDataSource({
          sourceId,
          tableName,
          aggregations,
          limit: 1,
        });
        const row = result.rows[0] ?? {};
        const statsOut: Record<
          string,
          { min: unknown; max: unknown; avg: unknown; sum: unknown; count: unknown }
        > = {};
        for (const f of statFields) {
          statsOut[f] = {
            min: row[`${f}__min`],
            max: row[`${f}__max`],
            avg:
              typeof row[`${f}__avg`] === 'number'
                ? Math.round((row[`${f}__avg`] as number) * 100) / 100
                : row[`${f}__avg`],
            sum: row[`${f}__sum`],
            count: row[`${f}__count`],
          };
        }
        return jsonResult({ sourceId, stats: statsOut }, true);
      } catch (err) {
        return errorResult(String(err));
      }
    },
  };
}
