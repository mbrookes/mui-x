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
import { capFilterValue, MAX_FILTER_STRING_LENGTH } from '../executeToolOnState';
import {
  checkAllowedTable,
  errorResult,
  jsonResult,
  withTimeout,
  type ToolHandler,
} from './helpers';
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

/**
 * Hard upper bound on the number of `fields` a single `compute_field_stats` call
 * may request (Tier 3, iteration 22). Each field fans out into FIVE aggregations
 * (min/max/avg/sum/count — see the `aggregations` build below), so an unbounded
 * `fields` array turns one tool call into an unbounded amount of DB aggregation
 * work in a single query. Rejected with a clear, actionable error rather than
 * silently truncated, so the model learns to split the request instead of
 * silently getting stats for a subset of the fields it asked for.
 */
const MAX_COMPUTE_FIELD_STATS_FIELDS = 50;

/**
 * Hard upper bound on the number of entries accepted in each of `query_data_source`'s
 * `columns` / `filters` / `aggregations` / `having` / `orderBy` arrays (Tier 3,
 * iteration 25, finding T2-3). Before this cap, all five arrays were cast and
 * forwarded to `data.queryDataSource` verbatim — only `limit`/`offset` were
 * clamped — even though `compute_field_stats` (above) already rejects an
 * oversized `fields` array with the exact same rationale ("each field/entry fans
 * out into DB aggregation work, so an unbounded array turns one tool call into
 * unbounded work") and `query_data_source` is reachable in exactly one hop with
 * the identical class of unbounded arrays (e.g. 50,000 `aggregations` entries, or
 * a megabyte-sized `filters[].value`). Reuses `MAX_COMPUTE_FIELD_STATS_FIELDS`'s
 * 50-entry convention for all five arrays rather than inventing five separate
 * constants — there is no tool-specific reason `filters` should be allowed a
 * different bound than `aggregations`, say.
 */
const MAX_QUERY_ARRAY_LENGTH = MAX_COMPUTE_FIELD_STATS_FIELDS;

/**
 * Validate an optional model-supplied array argument to a data-query tool
 * (`query_data_source`'s `columns` / `filters` / `aggregations` / `having` /
 * `orderBy`, and — finding 4, Tier 3 — `compute_field_stats`'s `fields`).
 *
 * Rejects (never silently truncates or coerces) a non-array value outright —
 * mirroring `compute_field_stats`'s own reject-don't-truncate stance — since a
 * malformed shape would otherwise reach `data.queryDataSource` cast but
 * unvalidated, producing a raw driver error (or worse, unpredictable behavior)
 * that depends entirely on the host's implementation. Also rejects an oversized
 * array with the same actionable "split the request" guidance
 * `compute_field_stats` gives for its own `fields` cap (see
 * `MAX_QUERY_ARRAY_LENGTH`). Returns the validated array unchanged (or
 * `undefined` when the arg was omitted) so the caller can forward it as-is.
 *
 * `toolName` is threaded through (rather than hardcoded) so the error message
 * names whichever tool actually rejected the call — `compute_field_stats`'s
 * `fields` and `query_data_source`'s five arrays share this one validator, and a
 * `compute_field_stats` caller should not be told to fix `query_data_source`.
 */
function validateQueryArrayArg<T>(
  toolName: string,
  argName: string,
  value: unknown,
): { ok: true; value: T[] | undefined } | { ok: false; error: ReturnType<typeof errorResult> } {
  if (value === undefined) {
    return { ok: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      error: errorResult(
        `${toolName}: "${argName}" must be an array, received ${typeof value}. ` +
          `Pass an array of ${argName} entries, or omit "${argName}" entirely.`,
      ),
    };
  }
  if (value.length > MAX_QUERY_ARRAY_LENGTH) {
    return {
      ok: false,
      error: errorResult(
        `${toolName} received ${value.length} "${argName}" entries, which exceeds the limit of ` +
          `${MAX_QUERY_ARRAY_LENGTH}. Split the request into multiple calls of at most ` +
          `${MAX_QUERY_ARRAY_LENGTH} ${argName} entries each.`,
      ),
    };
  }
  return { ok: true, value: value as T[] };
}

/**
 * Validate + cap the elements of a model-supplied STRING array argument
 * (`query_data_source`'s `columns`) (finding F4, Tier 2). `validateQueryArrayArg`
 * above only checks array-ness and overall length — nothing stopped an
 * individual element from being an object/number (forwarded to
 * `data.queryDataSource` as a nonsensical "column name") or a multi-megabyte
 * string (an unbounded-work/token-bomb class identical to the one
 * `capFilterValue` already guards `filters[].value` against). A non-string
 * element is rejected outright (not recoverable by truncation — mirrors
 * `compute_field_stats`'s existing non-string-`fields`-element rejection); an
 * oversized-but-otherwise-valid string is truncated to
 * {@link MAX_FILTER_STRING_LENGTH} rather than rejected, the same cap
 * `add_page_filter`/`add_widget_filter` apply to a persisted filter's `field`.
 */
function validateAndCapStringArrayElements(
  toolName: string,
  argName: string,
  entries: unknown[],
): { ok: true; value: string[] } | { ok: false; error: ReturnType<typeof errorResult> } {
  const capped: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    if (typeof entry !== 'string') {
      return {
        ok: false,
        error: errorResult(
          `${toolName}: "${argName}[${i}]" must be a string, received ` +
            `${Array.isArray(entry) ? 'array' : typeof entry}. Pass an array of column-name strings.`,
        ),
      };
    }
    capped.push(
      entry.length > MAX_FILTER_STRING_LENGTH ? entry.slice(0, MAX_FILTER_STRING_LENGTH) : entry,
    );
  }
  return { ok: true, value: capped };
}

/**
 * Validate + cap the RECORD-shaped elements of `query_data_source`'s
 * `aggregations` / `having` / `orderBy` / `filters` arrays (finding F4, Tier 2).
 * `validateQueryArrayArg` above only checks array-ness and overall length —
 * nothing stopped a `null`/non-object entry, or a string-valued field
 * (`column`/`func`/`alias`/`operator`/`direction`/`field`) from being an
 * arbitrary non-string value or an unbounded string, from reaching
 * `data.queryDataSource` verbatim.
 *
 * Each entry must be a plain object (rejected otherwise). Any of `stringFields`
 * present on it must, if present, be a string — rejected if not (an
 * object/array/number masquerading as e.g. a column name is not recoverable by
 * truncation) — and is truncated to {@link MAX_FILTER_STRING_LENGTH} if
 * oversized rather than rejected outright, mirroring
 * `validateAndCapStringArrayElements` above. Fields not listed in
 * `stringFields` (e.g. `having`'s numeric `value`) are left untouched — full
 * schema validation of every field is out of scope here, same as
 * `validateQueryArrayArg`'s own shallow-but-effective stance.
 */
function validateAndCapRecordArrayElements<T extends object>(
  toolName: string,
  argName: string,
  entries: T[],
  stringFields: readonly string[],
): { ok: true; value: T[] } | { ok: false; error: ReturnType<typeof errorResult> } {
  const capped: T[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry: unknown = entries[i];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return {
        ok: false,
        error: errorResult(
          `${toolName}: "${argName}[${i}]" must be an object, received ` +
            `${Array.isArray(entry) ? 'array' : typeof entry}.`,
        ),
      };
    }
    const record = entry as unknown as Record<string, unknown>;
    // The named `stringFields` must, if present, be strings — an object/array/number
    // masquerading as e.g. a column name is not recoverable by truncation.
    for (const field of stringFields) {
      const fieldValue = record[field];
      if (fieldValue !== undefined && typeof fieldValue !== 'string') {
        return {
          ok: false,
          error: errorResult(
            `${toolName}: "${argName}[${i}].${field}" must be a string, received ` +
              `${Array.isArray(fieldValue) ? 'array' : typeof fieldValue}.`,
          ),
        };
      }
    }
    // Finding F5 (Tier 3): cap EVERY string-typed value on the record — not just the
    // named `stringFields`. The previous `{ ...record }` spread forwarded any UNLISTED
    // key verbatim, so an extra key carrying an unbounded string reached
    // `data.queryDataSource` uncapped. Projecting each string down to
    // {@link MAX_FILTER_STRING_LENGTH} closes that hole while leaving non-string values
    // (numbers such as `having`'s `value`, booleans) untouched.
    const cappedRecord: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      cappedRecord[key] =
        typeof value === 'string' && value.length > MAX_FILTER_STRING_LENGTH
          ? value.slice(0, MAX_FILTER_STRING_LENGTH)
          : value;
    }
    capped.push(cappedRecord as unknown as T);
  }
  return { ok: true, value: capped };
}

/**
 * Cap on the number of numeric fields `describe_data_source` fans out into
 * per-field aggregation queries (Tier 3, iteration 24, finding 5), mirroring
 * `MAX_COMPUTE_FIELD_STATS_FIELDS` above — both bound "how many per-field
 * aggregation queries can one tool call issue in a single `Promise.all`".
 *
 * Unlike `compute_field_stats`, the field set here is NOT model-supplied — it's
 * every `type: 'number'` field on the resolved source — so there is no smaller
 * request for the model to retry with, and rejecting the call outright would
 * just dead-end it. Instead of rejecting, the fan-out is truncated to the first
 * N numeric fields (in schema order) and the response notes the truncation so
 * the model knows some numeric fields have no `stats` (it can still recover the
 * rest via `compute_field_stats` with an explicit `fields` list). Reuses the
 * same limit as `MAX_COMPUTE_FIELD_STATS_FIELDS` since there's no tool-specific
 * reason for a different number.
 */
const MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS = MAX_COMPUTE_FIELD_STATS_FIELDS;

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
  const tableCheckError = checkAllowedTable(sourceId, source.tableName, allowedTables);
  if (tableCheckError) {
    return { ok: false, error: errorResult(tableCheckError) };
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

      // Reject (not silently truncate/forward) a malformed or oversized `columns` /
      // `filters` / `aggregations` / `having` / `orderBy` array before any of them
      // reach `data.queryDataSource` (T2-3) — see `validateQueryArrayArg`'s doc
      // comment.
      const columnsResult = validateQueryArrayArg<string>('query_data_source', 'columns', columns);
      if (!columnsResult.ok) {
        return columnsResult.error;
      }
      const filtersResult = validateQueryArrayArg<StudioDataFilter>(
        'query_data_source',
        'filters',
        filters,
      );
      if (!filtersResult.ok) {
        return filtersResult.error;
      }
      const aggregationsResult = validateQueryArrayArg<StudioDataAggregation>(
        'query_data_source',
        'aggregations',
        aggregations,
      );
      if (!aggregationsResult.ok) {
        return aggregationsResult.error;
      }
      const havingResult = validateQueryArrayArg<StudioDataHavingPredicate>(
        'query_data_source',
        'having',
        having,
      );
      if (!havingResult.ok) {
        return havingResult.error;
      }
      const orderByResult = validateQueryArrayArg<StudioDataOrderBy>(
        'query_data_source',
        'orderBy',
        orderBy,
      );
      if (!orderByResult.ok) {
        return orderByResult.error;
      }

      // Finding F4 (Tier 2): `validateQueryArrayArg` above only validates
      // array-ness and overall length — it never inspected individual ELEMENTS,
      // so an object/multi-megabyte string in `columns`, or a non-string
      // `column`/`func`/`alias`/`operator`/`direction`/`field` (or an unbounded
      // one) in `aggregations`/`having`/`orderBy`/`filters`, reached
      // `data.queryDataSource` verbatim. Validate + cap each array's elements now
      // that array-shape is already confirmed.
      const columnsElementsResult = columnsResult.value
        ? validateAndCapStringArrayElements('query_data_source', 'columns', columnsResult.value)
        : undefined;
      if (columnsElementsResult && !columnsElementsResult.ok) {
        return columnsElementsResult.error;
      }
      const filtersElementsResult = filtersResult.value
        ? validateAndCapRecordArrayElements('query_data_source', 'filters', filtersResult.value, [
            'field',
            'operator',
          ])
        : undefined;
      if (filtersElementsResult && !filtersElementsResult.ok) {
        return filtersElementsResult.error;
      }
      const aggregationsElementsResult = aggregationsResult.value
        ? validateAndCapRecordArrayElements(
            'query_data_source',
            'aggregations',
            aggregationsResult.value,
            ['column', 'func', 'alias'],
          )
        : undefined;
      if (aggregationsElementsResult && !aggregationsElementsResult.ok) {
        return aggregationsElementsResult.error;
      }
      const havingElementsResult = havingResult.value
        ? validateAndCapRecordArrayElements('query_data_source', 'having', havingResult.value, [
            'alias',
            'operator',
          ])
        : undefined;
      if (havingElementsResult && !havingElementsResult.ok) {
        return havingElementsResult.error;
      }
      const orderByElementsResult = orderByResult.value
        ? validateAndCapRecordArrayElements('query_data_source', 'orderBy', orderByResult.value, [
            'column',
            'direction',
          ])
        : undefined;
      if (orderByElementsResult && !orderByElementsResult.ok) {
        return orderByElementsResult.error;
      }

      // Cap each filter's `value`/`value2` the same way `add_page_filter` /
      // `add_widget_filter` cap a PERSISTED filter's value (T2-3): these `filters`
      // are forwarded to the host's `queryDataSource` rather than persisted onto
      // dashboard state, but a megabyte-sized string/array `value` is the identical
      // unbounded-work/token-bomb class `capFilterValue` already guards against —
      // `checkAllowedTable`'s allowlist stops an out-of-scope TABLE, not an
      // oversized filter VALUE bound for an otherwise-permitted query.
      const cappedFilters = filtersElementsResult?.ok
        ? filtersElementsResult.value.map((f) => ({
            ...f,
            value: capFilterValue(f.value),
            ...(f.value2 !== undefined && { value2: capFilterValue(f.value2) }),
          }))
        : undefined;

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
        // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
        // own `data.queryDataSource` calls (Tier 3, iteration 22) — without it, a hung host
        // query implementation leaves this tool call (and the agentic loop turn awaiting it)
        // pending indefinitely.
        const result = await withTimeout(
          data.queryDataSource({
            sourceId,
            tableName,
            columns: columnsElementsResult?.ok ? columnsElementsResult.value : undefined,
            filters: cappedFilters,
            aggregations: aggregationsElementsResult?.ok
              ? aggregationsElementsResult.value
              : undefined,
            ...(havingElementsResult?.ok &&
              havingElementsResult.value.length > 0 && { having: havingElementsResult.value }),
            orderBy: orderByElementsResult?.ok ? orderByElementsResult.value : undefined,
            limit: clampedLimit,
            ...(offset !== undefined && { offset: clampedOffset }),
          }),
          15_000,
          `query for ${tableName}`,
        );

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
        const allNumericFields = visibleFields.filter((f) => f.type === 'number');
        // Truncate (not reject) an oversized numeric-field fan-out — see
        // `MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS`'s doc comment for why this tool
        // truncates instead of rejecting like `compute_field_stats` does.
        const statsTruncated = allNumericFields.length > MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS;
        const numericFields = statsTruncated
          ? allNumericFields.slice(0, MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS)
          : allNumericFields;

        // Run sample rows and row count in parallel with per-field numeric stats. Each
        // query is bounded with the same `withTimeout` pattern `mcp/summarisePage.ts`
        // applies to its own `data.queryDataSource` calls (Tier 3, iteration 22) — a hung
        // per-field stats query would otherwise stall this tool call indefinitely (the
        // sample query) or silently never resolve into `statsResults` (the per-field
        // queries, each already `.catch(() => null)`-guarded against a query error but not
        // against one that never settles at all).
        const [sampleResult, ...statsResults] = await Promise.all([
          withTimeout(
            data.queryDataSource({ sourceId, tableName, limit: 10 }),
            15_000,
            `sample query for ${tableName}`,
          ),
          ...numericFields.map((f) =>
            withTimeout(
              data.queryDataSource({
                sourceId,
                tableName,
                aggregations: [
                  { column: f.id, func: 'min', alias: 'min' },
                  { column: f.id, func: 'max', alias: 'max' },
                  { column: f.id, func: 'avg', alias: 'avg' },
                  { column: f.id, func: 'sum', alias: 'sum' },
                ],
                limit: 1,
              }),
              15_000,
              `stats query for ${tableName}.${f.id}`,
            ).catch(() => null),
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
            ...(statsTruncated && {
              statsTruncated: true,
              statsTruncatedNote:
                `Numeric-field stats were computed for only the first ${MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS} ` +
                `of ${allNumericFields.length} numeric fields on this source. Call compute_field_stats with ` +
                'the remaining field ids to get stats for the rest.',
            }),
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
        fieldId: rawFieldId,
        limit: fieldLimit,
      } = (args ?? {}) as {
        sourceId: string;
        fieldId: unknown;
        limit?: number;
      };
      if (!sourceId || !rawFieldId) {
        return errorResult('sourceId and fieldId are required');
      }
      // Finding F4 (Tier 2): `fieldId` was only truthiness-checked, so a
      // non-string truthy value (e.g. an object or number) reached
      // `data.queryDataSource` verbatim as a nonsensical "column name". Require a
      // non-empty string and cap it at {@link MAX_FILTER_STRING_LENGTH} — the same
      // bound `add_page_filter`/`add_widget_filter` apply to a persisted filter's
      // `field` — rather than forwarding an unbounded one.
      if (typeof rawFieldId !== 'string') {
        return errorResult(
          `get_field_values: "fieldId" must be a non-empty string, received ${typeof rawFieldId}.`,
        );
      }
      const fieldId =
        rawFieldId.length > MAX_FILTER_STRING_LENGTH
          ? rawFieldId.slice(0, MAX_FILTER_STRING_LENGTH)
          : rawFieldId;
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
        // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
        // own `data.queryDataSource` calls (Tier 3, iteration 22).
        const result = await withTimeout(
          data.queryDataSource({
            sourceId,
            tableName,
            columns: [fieldId],
            aggregations: [{ column: fieldId, func: 'count', alias: 'count' }],
            orderBy: [{ column: 'count', direction: 'desc' }],
            limit: clampedFieldLimit,
          }),
          15_000,
          `field-values query for ${tableName}.${fieldId}`,
        );
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
      const { sourceId, fields: rawFields } = (args ?? {}) as {
        sourceId: string;
        fields: unknown;
      };
      if (!sourceId || rawFields === undefined) {
        return errorResult('sourceId and fields (non-empty array) are required');
      }
      // Finding 4 (Tier 3): validate `fields` IS an array (not e.g. a bare string,
      // which also has `.length` and so previously slipped past the emptiness/size
      // checks below) before touching it further — the same array-shape + size-cap
      // validation `query_data_source`'s five array args already get from
      // `validateQueryArrayArg`. Reuses `MAX_COMPUTE_FIELD_STATS_FIELDS` as the cap
      // (each field fans out into 5 aggregations in a single query, so an unbounded
      // request performs unbounded aggregation work).
      const fieldsResult = validateQueryArrayArg<unknown>(
        'compute_field_stats',
        'fields',
        rawFields,
      );
      if (!fieldsResult.ok) {
        return fieldsResult.error;
      }
      const rawStatFields = fieldsResult.value ?? [];
      if (rawStatFields.length === 0) {
        return errorResult('sourceId and fields (non-empty array) are required');
      }
      // `validateQueryArrayArg`'s cast only guarantees array-ness, not that every
      // entry is actually a `string` — a non-string element (e.g. a number or a
      // nested object) would otherwise be forwarded verbatim as an aggregation
      // `column` to `data.queryDataSource` below. Run it through the SAME
      // validate-and-cap helper `query_data_source`'s `columns` uses (finding F5,
      // Tier 3): a non-string element is rejected, and an oversized-but-valid field id
      // is truncated to `MAX_FILTER_STRING_LENGTH` — previously the element type was
      // checked but the string length was NOT capped, unlike `columns`.
      const statFieldsResult = validateAndCapStringArrayElements(
        'compute_field_stats',
        'fields',
        rawStatFields,
      );
      if (!statFieldsResult.ok) {
        return statFieldsResult.error;
      }
      const statFields = statFieldsResult.value;
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
        // Bounded with the same `withTimeout` pattern `mcp/summarisePage.ts` applies to its
        // own `data.queryDataSource` calls (Tier 3, iteration 22).
        const result = await withTimeout(
          data.queryDataSource({
            sourceId,
            tableName,
            aggregations,
            limit: 1,
          }),
          15_000,
          `field-stats query for ${tableName}`,
        );
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
