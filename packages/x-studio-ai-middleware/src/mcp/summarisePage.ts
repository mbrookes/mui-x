/**
 * The `summarise_page` MCP tool handler: per-widget stats, a CSV excerpt, and
 * (for time-series charts) GROUP BY-based anomaly detection.
 *
 * Split out of `dataTools.ts` because this handler — together with its two
 * anomaly-detection constants below — is ~200 lines of stats/CSV/anomaly logic
 * that no other handler in this module depends on.
 */

import {
  detectAnomaliesIQR,
  truncateToPeriod,
  isWidgetOfKind,
  type StudioChartConfig,
} from '@mui/x-studio-schema';
import { sanitizeForPromptLine } from '../buildAISystemPrompt';
import {
  checkAllowedTable,
  describeErrorForLog,
  errorResult,
  mapWithConcurrency,
  MAX_CONCURRENT_HOST_QUERIES,
  opLabel,
  safeIdentifier,
  sanitizeMaxQueryRows,
  validateTableName,
  withTimeout,
  type ToolHandler,
} from './helpers';
import { validateAndCapStringArrayElements } from './queryTools';
import type {
  StudioDataAggregation,
  StudioMcpData,
  StudioMcpLogger,
  StudioStateBox,
} from './types';

// The period-truncation (`truncateToPeriod`) and IQR anomaly-detection
// (`detectAnomaliesIQR`) helpers both live in `@mui/x-studio-schema` — the
// zero-dependency package shared with `@mui/x-studio`'s client-side
// `internals/temporalUtils.ts`, so the two packages no longer hand-maintain
// separate copies of the same date-bucketing logic.

const ANOMALY_CHART_TYPES = new Set(['bar', 'bar-stacked', 'bar-100', 'line']);

/**
 * `yAggregation` values for which summing per-x-value aggregates into a period
 * bucket is mathematically sound. `avg`/`min`/`max` are excluded: summing daily
 * averages is not a monthly average, summing daily maxes is not a monthly max,
 * etc. — combining those correctly needs a per-bucket count (for a weighted
 * mean) or a running min/max, neither of which is tracked here, so the anomaly
 * path is skipped entirely for those aggregations rather than feeding
 * `detectAnomaliesIQR` a mathematically bogus input.
 *
 * This is a strict SUBSET of `QUERY_AGGREGATION_FUNCS` (`mcp/queryTools.ts`), the
 * closed set every `aggregations[].func` bound for `data.queryDataSource` is now
 * validated against — this gate was the package's ONLY value-domain
 * check on a `func` before that, which is what proved the omission over there was an
 * oversight rather than a stance. The `satisfies` annotation is the drift lock: an
 * entry here that is not a member of the shared union fails to compile, so the subset
 * relationship cannot silently break. It is deliberately NOT derived by filtering the
 * shared set — the exclusion is a mathematical statement about combining buckets, not
 * a security bound, and the two must stay free to differ.
 */
const ANOMALY_SAFE_AGGREGATIONS: ReadonlySet<string> = new Set([
  'sum',
  'count',
] satisfies StudioDataAggregation['func'][]);

/**
 * Hard upper bound on the number of widgets `summarise_page` fans out per-widget
 * `queryDataSource` calls for. `Promise.all` below issues up
 * to TWO live queries per widget (a sample-rows query, and — for time-series
 * charts — a GROUP BY anomaly-aggregation query) concurrently, with no prior cap
 * on widget count, unlike sibling fan-outs in `queryTools.ts`
 * (`MAX_COMPUTE_FIELD_STATS_FIELDS`/`MAX_DESCRIBE_DATA_SOURCE_NUMERIC_FIELDS`,
 * both capped at 50). Reuses that same 50-item convention rather than inventing a
 * new constant — there is no tool-specific reason a page's widget fan-out should
 * be allowed a different bound. Truncated (not rejected) — like
 * `describe_data_source`'s numeric-field fan-out — since a page's widget count
 * isn't something the caller can retry with a smaller value; the summary simply
 * covers the first N widgets in layout order and notes the truncation.
 */
const MAX_SUMMARISE_PAGE_WIDGETS = 50;

/**
 * Hard upper bound on the number of anomaly bucket labels appended to a widget's
 * section. `detectAnomaliesIQR` can flag up to one bucket per GROUP BY
 * row — `min(20000, maxQueryRows)` of them — and every flagged label used to be
 * `join(', ')`-ed into this LLM-consumed summary, so a high-cardinality
 * `xGroupBy` produced an unbounded block of text per widget. The overflow count is
 * still reported, so the model knows how many anomalies were found.
 */
const MAX_ANOMALY_LABELS = 20;

/**
 * The one escape this file needs on top of {@link sanitizeForPromptLine}, applied
 * to the CSV block's header labels and cell values.
 *
 * The excerpt this handler emits is TAB-separated, one record per line, inside a
 * ``` fence. `sanitizeForPromptLine` already neutralizes the line delimiter (CR/LF
 * become a literal `\n` escape), which is what stops a cell from closing the fence
 * or opening a forged `### …` heading. It knows nothing about this file's FIELD
 * delimiter, though, so a cell containing a tab would still split into two columns
 * and shift every following value under the wrong header.
 *
 * Invariant: one source cell renders as exactly one field on exactly one line, so
 * the excerpt's shape is determined entirely by `visibleFields` and the row count —
 * never by the content of a row.
 */
function sanitizeCsvValue(value: unknown): string {
  return sanitizeForPromptLine(value).replace(/\t/g, '\\t');
}

/**
 * Format a host-reported `rowCount` for the `### … (N rows)` heading.
 *
 * `rowCount` is typed `number`, but it is HOST-supplied — and `node-pg` returns
 * `COUNT(*)` as a STRING by default (bigint doesn't fit a JS number), which is the
 * single most common shape a real host hands back here. `rowCount.toLocaleString()`
 * does not throw on a string (every value has `toLocaleString`), it just returns the
 * string unchanged — so this was the one remaining UNESCAPED interpolation in the
 * raw-markdown block, and everything else in that block is sanitized precisely
 * because a widget section is LLM-consumed text that must not be forgeable.
 *
 * A numeric-looking value (number or numeric string) is formatted as a number, which
 * is structurally incapable of carrying markup. Anything else falls back to the
 * single-line sanitizer, like every other untrusted value in this file.
 */
function formatRowCount(rowCount: unknown): string {
  const asNumber = typeof rowCount === 'number' ? rowCount : Number(rowCount);
  return Number.isFinite(asNumber) ? asNumber.toLocaleString() : sanitizeForPromptLine(rowCount);
}

/**
 * Build the `summarise_page` handler. Registered only when `data` is configured;
 * without data the tool falls through to `executeToolOnState`, which returns a
 * descriptive client-side-limitation error.
 */
export function createSummarisePageHandler(deps: {
  stateBox: StudioStateBox;
  data: StudioMcpData;
  logger?: StudioMcpLogger;
  /**
   * Hard upper bound applied to the per-widget anomaly aggregation query's
   * `limit` (Tier 3 finding 6), mirroring `QueryToolDeps.maxQueryRows` (the same
   * host-configured bound `query_data_source` respects). Optional for backward
   * compatibility with existing callers/tests that don't pass it — falls back to
   * the shared `DEFAULT_MAX_QUERY_ROWS` (`./helpers`) when omitted, same default
   * `mcp.ts` uses for `MAX_QUERY_ROWS` when the host supplies none.
   */
  maxQueryRows?: number;
  /**
   * Per-source authorization consult, run once per DISTINCT widget `sourceId` on the
   * resolved page before any live query for that source runs.
   *
   * `mcp.ts` gates `summarise_page` itself under `query_data_source`
   * SOURCE-AGNOSTICALLY (it spans the whole page), by analogy with the multi-source
   * `studio://dashboard/data-health` resource. But that analogy only holds for
   * `data-health`: its source set is HOST-controlled and it returns nothing but
   * counts, whereas this handler's source set is MODEL-controlled
   * (`add_widget`/`update_widget` accept any `sourceId` — `buildWidgetFromArgs` caps
   * the string but performs no existence or authorization check) and it returns 5
   * real rows per widget. A host whose policy denies `query_data_source` for
   * `ctx.input.sourceId === 'source-hr'` — the documented per-source rule that
   * `authorizeResourceDataAccess` threads `sourceId` for — could therefore be
   * bypassed by adding an HR-sourced widget (a mutation, so the rule does not fire)
   * and then calling `summarise_page`.
   *
   * Resolves to a deny-reason string (the widget is then skipped, like the
   * `checkAllowedTable` denial below) or `null` to proceed. When omitted, no
   * per-source gate is applied (used only by unit tests and callers that construct
   * the handler directly).
   * @param {{ sourceId: string }} input The source about to be queried.
   * @param {string} input.sourceId Id of the data source the widget would read.
   * @returns {Promise<string | null>} A deny-reason string, or `null` to proceed.
   */
  authorizeSourceDataAccess?: (input: { sourceId: string }) => Promise<string | null>;
}): ToolHandler {
  const { stateBox, data, logger, authorizeSourceDataAccess } = deps;
  // Finding L2: a host-supplied `maxQueryRows` was taken on trust, so an
  // unparseable one (`Number(process.env.MAX_QUERY_ROWS)` on an unset variable is
  // `NaN`) made the anomaly query's `Math.min(20_000, maxQueryRows)` evaluate to
  // `NaN` and handed the host `LIMIT NaN` — the exact failure the clamp exists to
  // prevent, arriving through the clamp itself. `sanitizeMaxQueryRows` (`./helpers`)
  // covers both an OMITTED value and an unusable-but-PRESENT one.
  const maxQueryRows = sanitizeMaxQueryRows(deps.maxQueryRows);

  return async (args) => {
    const state = stateBox.current;
    // Accept optional pageId arg; fall back to active page.
    // Finding M7: `pageId` was never type-checked — a non-string truthy value (an
    // object, an array) reached the `Object.hasOwn` lookup and the not-found message
    // verbatim. Reject it the same way every sibling identifier arg in
    // `queryTools.ts` is rejected, rather than stringifying something nonsensical.
    const rawPageId = (args as { pageId?: unknown } | undefined)?.pageId;
    if (rawPageId !== undefined && typeof rawPageId !== 'string') {
      return errorResult(
        `summarise_page: "pageId" must be a string, received ${
          Array.isArray(rawPageId) ? 'array' : typeof rawPageId
        }. Pass a page id from list_pages, or omit "pageId" to summarise the active page.`,
      );
    }
    const requestedPageId = rawPageId;
    const resolvedPageId = requestedPageId ?? state.doc.dashboard.activePageId;
    // `Object.hasOwn`-guarded lookup: a prototype-member pageId
    // (`"constructor"`) would otherwise resolve to a truthy inherited function and
    // degrade to a confusing "No queryable widgets" path instead of a clean not-found.
    const activePage =
      resolvedPageId && Object.hasOwn(state.doc.pages, resolvedPageId)
        ? state.doc.pages[resolvedPageId]
        : null;

    if (!activePage) {
      return {
        content: [
          {
            type: 'text' as const,
            text: requestedPageId
              ? // `requestedPageId` is caller-supplied and echoed
                // raw into this LLM-consumed tool output. Route it through
                // `safeIdentifier` — the shared sanitize-AND-cap choke point for an
                // untrusted identifier echoed into error prose. It was previously only
                // sanitized, leaving a multi-megabyte `pageId` free to
                // become a multi-megabyte tool result.
                `Page "${safeIdentifier(requestedPageId)}" not found.`
              : 'No active page found.',
          },
        ],
      };
    }

    const widgetIds = (activePage.widgetRows ?? []).flat();
    // `Object.hasOwn`-guarded lookup (finding T3-1, for parity with the pageId /
    // sourceId guards): a widget-row id that is an `Object.prototype` member
    // (`"constructor"`, `"toString"`, …) would otherwise resolve to an inherited
    // function via the prototype chain instead of being dropped as absent.
    const allWidgets = widgetIds
      .filter((id) => Object.hasOwn(state.doc.widgets, id))
      .map((id) => state.doc.widgets[id]);
    // Finding F5: truncate (not reject) an oversized widget fan-out —
    // see `MAX_SUMMARISE_PAGE_WIDGETS`'s doc comment.
    const widgetsTruncated = allWidgets.length > MAX_SUMMARISE_PAGE_WIDGETS;
    const widgets = widgetsTruncated ? allWidgets.slice(0, MAX_SUMMARISE_PAGE_WIDGETS) : allWidgets;
    type SectionItem = { text: string };
    // Pre-sized, index-addressed array: each widget's query runs concurrently
    // (via Promise.all below), but writing to `results[i]` instead of pushing
    // onto a shared array preserves page/layout order in the final summary
    // regardless of which query settles first.
    const results: (SectionItem | null)[] = new Array(widgets.length).fill(null);

    // Finding H3: consult the per-source gate ONCE per distinct `sourceId`, not once
    // per widget. The consult increments the session's tool-call usage and may bridge
    // to the host's approval channel, so a page with 20 widgets on one source must not
    // spend 20 budget units or prompt a human 20 times. Memoised on the in-flight
    // promise so concurrent widgets sharing a source await the same consult.
    const sourceAuthorization = new Map<string, Promise<string | null>>();
    const authorizeSource = (sourceId: string): Promise<string | null> => {
      if (!authorizeSourceDataAccess) {
        return Promise.resolve(null);
      }
      let pending = sourceAuthorization.get(sourceId);
      if (!pending) {
        // FAIL CLOSED on a throwing gate: the consult reaches host code (`toolPolicy`,
        // `approvalHandler`), and a host bug must skip the widget, never wave it
        // through. The detail goes to the server log, never into the summary.
        pending = authorizeSourceDataAccess({ sourceId }).catch((err) => {
          // `describeErrorForLog`, not `String(err)`: the raw global
          // throws for a rejection value of `{"toString": 1}`, and a logger inside a
          // `.catch` that throws re-rejects the very promise this handler is guarding.
          logger?.error(
            `[mcp] summarise_page per-source authorization threw: ${describeErrorForLog(err)}`,
          );
          return 'the per-source authorization check failed';
        });
        sourceAuthorization.set(sourceId, pending);
      }
      return pending;
    };

    // Bounded-concurrency fan-out. `MAX_SUMMARISE_PAGE_WIDGETS` bounds how
    // many widgets are covered (50) and each widget issues up to TWO live queries, so
    // the previous bare `Promise.all` could open ~100 host connections at once and
    // drain a pool the host sized for its whole application. `withTimeout` does not
    // help — it bounds the WAIT, not the WORK. The sibling `@mui/x-studio-data-middleware`
    // already bounds its own batch fan-out this way; this is the same bound on this
    // side of the boundary. Layout order is still preserved by the pre-sized `results`
    // array (and by `mapWithConcurrency`'s own input-order guarantee).
    await mapWithConcurrency(widgets, MAX_CONCURRENT_HOST_QUERIES, async (widget, i) => {
      const sourceId = widget.sourceId;
      if (!sourceId) {
        return;
      }
      // Finding M1: EVERYTHING per-widget runs inside this try, not just the queries.
      // The source resolution below reaches `validateTableName` / `checkAllowedTable`,
      // which read client-supplied state and host-supplied configuration — and a throw
      // from either (`allowedTables: null` used to make `null.includes` throw) escaped
      // the old inner `try`, rejecting the whole fan-out and failing the ENTIRE page
      // summary instead of skipping one widget. Per-widget isolation is the contract
      // this handler already states for every other kind of per-widget failure.
      try {
        // `Object.hasOwn`-guarded lookup (finding T2-1, for parity with the
        // `pageId` guard above): `widget.sourceId` is model-settable
        // (`add_widget`/`update_widget` accept any string with no existence
        // check), so a bare `dataSources[sourceId]` would otherwise walk the
        // prototype chain on an id like `"__proto__"`. This site was already
        // safe by accident (`Object.prototype.tableName === undefined`), but
        // the guard makes that explicit rather than incidental.
        const source = Object.hasOwn(state.runtime.dataSources, sourceId)
          ? state.runtime.dataSources[sourceId]
          : undefined;
        if (!source?.tableName) {
          return;
        }
        // TYPE- and length-validate `tableName` before it is forwarded to the host
        // (`validateTableName`): this handler resolves it straight out of
        // `runtime.dataSources`, which on the chat transport descends from the
        // client-supplied request body, and the previous `as string` casts below
        // asserted a type nothing had checked. Skipped (and logged) like the
        // allowlist denial below — one malformed source must not fail the whole page
        // summary. Every `data.queryDataSource` call in this handler now uses the
        // validated `tableName` local, so no `as string` cast remains.
        const tableNameResult = validateTableName(sourceId, source.tableName);
        if (!tableNameResult.ok) {
          logger?.error(
            `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${tableNameResult.error}`,
          );
          return;
        }
        const { tableName } = tableNameResult;
        // Same `allowedTables` allowlist check `resolveSource` (`queryTools.ts`)
        // applies before `query_data_source` et al. reach the database (Tier 3,
        // iteration 24, finding 4): `summarise_page` resolves `source.tableName`
        // directly from `runtime.dataSources` rather than through `resolveSource`,
        // so without this it could query a table outside the host's configured
        // allowlist. Skip the widget (like the missing-`tableName` case above)
        // rather than failing the whole page summary.
        const tableCheckError = checkAllowedTable(sourceId, tableName, data.allowedTables);
        if (tableCheckError) {
          logger?.error(
            `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${tableCheckError}`,
          );
          return;
        }
        // Per-source authorization — see `authorizeSourceDataAccess`'s doc
        // comment. Skipped exactly like the allowlist denial above: one denied source
        // must not fail the whole page summary, and the deny reason is logged
        // server-side rather than echoed into the LLM-consumed summary (the model must
        // not learn which sources exist but are off-limits).
        const authorizationError = await authorizeSource(sourceId);
        if (authorizationError) {
          logger?.error(
            `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${authorizationError}`,
          );
          return;
        }

        const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
        const numericFields = visibleFields.filter((f) => f.type === 'number');

        // Time-series charts span the bar/line families, so read the chart config
        // through the flat cross-family `StudioChartConfig` patch type.
        const chartCfg = isWidgetOfKind(widget, 'chart')
          ? (widget.config as StudioChartConfig)
          : undefined;
        const isTimeSeries =
          chartCfg !== undefined &&
          Boolean(chartCfg.xGroupBy) &&
          ANOMALY_CHART_TYPES.has(chartCfg.chartType ?? 'bar');

        const result = await withTimeout(
          data.queryDataSource({
            sourceId,
            tableName,
            limit: 50,
          }),
          15_000,
          // `opLabel`: `tableName` comes off
          // `runtime.dataSources`, which on the chat transport descends from the
          // client-supplied request body, and this label lands inside a BRANDED
          // `StudioTimeoutError` that `redactedHostErrorMessage` relays VERBATIM on the
          // premise that a branded message holds only server-authored prose. The tagged
          // template sanitizes the hole so the call site cannot forget to.
          opLabel`sample query for ${tableName}`,
        );

        const { rows, rowCount } = result;

        // Compute basic stats for numeric fields from the sample rows.
        const stats = numericFields
          .map((f) => {
            const values = rows.map((r) => Number(r[f.id])).filter((v) => !Number.isNaN(v));
            if (values.length === 0) {
              return null;
            }
            const sum = values.reduce((a, b) => a + b, 0);
            const min = Math.min(...values);
            const max = Math.max(...values);
            const avg = sum / values.length;
            // `f.label` is a state-derived (model/host-settable) data-source field
            // label, interpolated into ONE ` | `-separated entry of this summary's
            // single-line `Stats:` row — so it routes through
            // `sanitizeForPromptLine`, not the angle-bracket-only
            // `sanitizeForPrompt`. Escaping `<`/`>` alone would leave a label free to
            // emit its own newline and forge a whole sibling line (a `### …` heading,
            // a second `Stats:` row); collapsing CR/LF keeps it one entry on one line.
            return `${sanitizeForPromptLine(f.label)}: sum=${sum.toLocaleString()}, avg=${avg.toFixed(2)}, min=${min}, max=${max}`;
          })
          .filter(Boolean);

        // CSV excerpt — header + first 5 rows, tab-separated, inside a ``` fence.
        // Both the header labels (state-derived field labels) and the row cell values
        // (live, attacker-influenceable DB data) are LLM-consumed text once this
        // summary is returned to the agentic loop, and both occupy exactly one field
        // on one line — so they route through `sanitizeCsvValue`, which is
        // `sanitizeForPromptLine` plus this block's tab delimiter.
        //
        // The angle-bracket-only `sanitizeForPrompt` used to be enough here only by
        // luck: a cell value carrying a newline followed by ``` closes the fence
        // opened below, and anything after it — `### Revenue (999,999 rows)`, a forged
        // `Stats:` line — then reads as a genuine peer of the real widget sections
        // rather than as data.
        const headers = visibleFields.map((f) => sanitizeCsvValue(f.label));
        const csvRows = rows.slice(0, 5).map((r) =>
          visibleFields.map((f) => {
            const v = r[f.id];
            return v == null ? '' : sanitizeCsvValue(v);
          }),
        );
        const csv = [headers, ...csvRows].map((row) => row.join('\t')).join('\n');

        // `widget.title`/`source.label` are model/host-settable strings (`add_widget`
        // caps a title's LENGTH at 200 chars and constrains nothing else) echoed into
        // a single-line `### …` markdown heading — `sanitizeForPromptLine`, so a title
        // cannot end its heading and open a forged section of its own.
        const label = sanitizeForPromptLine(widget.title || source.label);
        const lines = [
          `### ${label} (${formatRowCount(rowCount)} rows)`,
          ...(stats.length > 0
            ? [`Stats (from ${rows.length} sample rows): ${stats.join(' | ')}`]
            : []),
          '```',
          csv,
          '```',
        ];

        // Time-series aggregation: GROUP BY query for anomaly detection and charting.
        // Skip blended charts — the y-field belongs to a different source's table.
        // Finding H2 — `Array.isArray`, and a per-element guard inside the predicate.
        // `(chartCfg.ySeries ?? [])` only defends against nullish: a committed
        // `ySeries: 'x'` (an allowed chart config key whose non-scalar value no write
        // gate validates) has no `.some`, and `ySeries: [null]` throws on `s.sourceId`.
        // Either one made `summarise_page` throw for that dashboard on every call.
        const ySeries = Array.isArray(chartCfg?.ySeries) ? chartCfg.ySeries : [];
        const isBlended =
          chartCfg !== undefined &&
          ySeries.some((s) => s?.sourceId && s.sourceId !== widget.sourceId);
        let tsLabels: string[] | null = null;
        let tsValues: number[] | null = null;

        if (isTimeSeries && !isBlended && chartCfg !== undefined) {
          const xField = chartCfg.xField;
          const yField = chartCfg.yField ?? (ySeries[0]?.fieldId as string | undefined);
          const yAgg = (chartCfg.yAggregation ?? 'sum') as 'sum' | 'avg' | 'count' | 'min' | 'max';
          const xGroupBy = chartCfg.xGroupBy!;
          // Finding M4: `xField`/`yField` come straight off the widget config, which
          // `add_widget`/`update_widget` accept from the model —
          // `capConfigStringValues` caps string LENGTH but preserves non-string types,
          // and only truthiness was checked here. An `xField: ['a','b']` /
          // `yField: { alias: 'x' }` therefore reached the host as
          // `columns: [['a','b']]` / `aggregations: [{ column: {…} }]`; a Knex host
          // reads that object as an alias map and projects an unintended column.
          // This was the only column-name path in the package that skipped the
          // validation `query_data_source` / `get_field_values` /
          // `compute_field_stats` all apply — run the very same helper, and skip the
          // anomaly path (never guess) when either field is not a string.
          const chartFields = validateAndCapStringArrayElements('summarise_page', 'chart fields', [
            xField,
            yField,
          ]);
          if (!chartFields.ok && xField !== undefined && yField !== undefined) {
            logger?.error(
              `[mcp] summarise_page skipped the anomaly aggregation for widget ` +
                `"${widget.title || sourceId}": xField/yField must be strings.`,
            );
          }
          const [safeXField, safeYField] = chartFields.ok
            ? chartFields.value
            : [undefined, undefined];
          if (safeXField && safeYField && ANOMALY_SAFE_AGGREGATIONS.has(yAgg)) {
            const aggResult = await withTimeout(
              data.queryDataSource({
                sourceId,
                tableName,
                columns: [safeXField],
                aggregations: [{ column: safeYField, func: yAgg, alias: 'y_agg' }],
                // Finding 6: this hardcoded 20,000 previously ignored the
                // host's configured `maxQueryRows` bound entirely. Cap at whichever
                // is smaller, matching `query_data_source`'s own
                // `Math.min(limit, maxQueryRows)` clamp.
                limit: Math.min(20_000, maxQueryRows),
              }),
              15_000,
              // `opLabel` for the same reason as the sample query's label above.
              opLabel`aggregation query for ${tableName}`,
            );
            const grouped = new Map<string, number>();
            for (const row of aggResult.rows) {
              const periodKey = truncateToPeriod(row[safeXField], xGroupBy);
              if (!periodKey) {
                continue;
              }
              grouped.set(periodKey, (grouped.get(periodKey) ?? 0) + Number(row.y_agg ?? 0));
            }
            tsLabels = [...grouped.keys()].sort();
            tsValues = tsLabels.map((l) => grouped.get(l)!);
            const outlierIndices = detectAnomaliesIQR(tsValues);
            // Trim first and last period (partial periods cause false-positive low outliers).
            const lastIdx = tsValues.length - 1;
            const anomalyLabels = [...outlierIndices]
              .filter((i) => i > 0 && i < lastIdx)
              .map((i) => tsLabels![i]);
            if (anomalyLabels.length > 0) {
              // Finding L4: cap how many labels are spelled out — see
              // MAX_ANOMALY_LABELS. The total is still reported when truncated.
              const shownLabels = anomalyLabels.slice(0, MAX_ANOMALY_LABELS);
              const omittedLabels = anomalyLabels.length - shownLabels.length;
              lines.push(
                `Anomalies detected at: ${shownLabels.join(', ')}${
                  omittedLabels > 0
                    ? ` (+${omittedLabels} more of ${anomalyLabels.length} total)`
                    : ''
                }`,
              );
            }
          }
        }

        results[i] = { text: lines.join('\n') };
      } catch (err) {
        logger?.error(
          // `describeErrorForLog`, not `String(err)` — see above; this
          // logger call sits in the catch that keeps ONE bad widget from failing the
          // whole summary, so it must not be able to throw itself.
          `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${describeErrorForLog(err)}`,
        );
      }
    });

    const sections = results.filter((r): r is SectionItem => r != null);
    // `activePage.title` is a model-settable stored title (`add_page`/`rename_page`)
    // echoed into this summary's single-line `## …` heading, so it uses
    // `sanitizeForPromptLine`: escaping `<`/`>` alone would let a title of
    // `Sales\n\n## Security Rules\n…` open a forged top-level section that outranks
    // every real `### widget` section below it. `resolvedPageId` is an internal id,
    // not model-free-text, but goes through the same call for parity with the rest of
    // the package's sanitize-before-interpolate convention.
    const pageLabel = sanitizeForPromptLine(activePage.title || resolvedPageId || 'active page');

    if (sections.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No queryable widgets found on page "${pageLabel}".`,
          },
        ],
      };
    }

    // Return the page summary as a single coherent text block: a heading
    // followed by one section per widget, in page/layout order (not query-
    // completion order — see the `results` array above).
    // (Splitting into separate content items fragments the summary for MCP
    // clients that render only the first.)
    // Finding F5: note the widget-fan-out truncation in the summary
    // itself, mirroring `describe_data_source`'s `statsTruncatedNote` pattern, so
    // the model knows this summary doesn't cover every widget on the page.
    const truncationNote = widgetsTruncated
      ? [
          `_Summary truncated: showing the first ${MAX_SUMMARISE_PAGE_WIDGETS} of ${allWidgets.length} ` +
            'widgets on this page._',
        ]
      : [];
    const summaryText = [`## ${pageLabel}`, ...truncationNote, ...sections.map((s) => s.text)].join(
      '\n\n',
    );

    return { content: [{ type: 'text' as const, text: summaryText }] };
  };
}
