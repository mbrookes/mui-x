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
import { sanitizeForPrompt } from '../buildAISystemPrompt';
import { checkAllowedTable, withTimeout, type ToolHandler } from './helpers';
import type { StudioMcpData, StudioMcpLogger, StudioStateBox } from './types';

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
 */
const ANOMALY_SAFE_AGGREGATIONS = new Set(['sum', 'count']);

/**
 * Build the `summarise_page` handler. Registered only when `data` is configured;
 * without data the tool falls through to `executeToolOnState`, which returns a
 * descriptive client-side-limitation error.
 */
export function createSummarisePageHandler(deps: {
  stateBox: StudioStateBox;
  data: StudioMcpData;
  logger?: StudioMcpLogger;
}): ToolHandler {
  const { stateBox, data, logger } = deps;

  return async (args) => {
    const state = stateBox.current;
    // Accept optional pageId arg; fall back to active page.
    const requestedPageId = (args as { pageId?: string })?.pageId;
    const resolvedPageId = requestedPageId ?? state.doc.dashboard.activePageId;
    // `Object.hasOwn`-guarded lookup (finding T2-1): a prototype-member pageId
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
              ? `Page "${requestedPageId}" not found.`
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
    const widgets = widgetIds
      .filter((id) => Object.hasOwn(state.doc.widgets, id))
      .map((id) => state.doc.widgets[id]);
    type SectionItem = { text: string };
    // Pre-sized, index-addressed array: each widget's query runs concurrently
    // (via Promise.all below), but writing to `results[i]` instead of pushing
    // onto a shared array preserves page/layout order in the final summary
    // regardless of which query settles first.
    const results: (SectionItem | null)[] = new Array(widgets.length).fill(null);

    await Promise.all(
      widgets.map(async (widget, i) => {
        const sourceId = widget.sourceId;
        if (!sourceId) {
          return;
        }
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
        // Same `allowedTables` allowlist check `resolveSource` (`queryTools.ts`)
        // applies before `query_data_source` et al. reach the database (Tier 3,
        // iteration 24, finding 4): `summarise_page` resolves `source.tableName`
        // directly from `runtime.dataSources` rather than through `resolveSource`,
        // so without this it could query a table outside the host's configured
        // allowlist. Skip the widget (like the missing-`tableName` case above)
        // rather than failing the whole page summary.
        const tableCheckError = checkAllowedTable(sourceId, source.tableName, data.allowedTables);
        if (tableCheckError) {
          logger?.error(
            `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${tableCheckError}`,
          );
          return;
        }

        const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
        const numericFields = visibleFields.filter((f) => f.type === 'number');

        try {
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
              tableName: source.tableName as string,
              limit: 50,
            }),
            15_000,
            `sample query for ${source.tableName}`,
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
              // label interpolated into this LLM-consumed summary text — route it
              // through `sanitizeForPrompt`, the package's single choke point for this
              // class of value (finding T3-3), same as `buildAISystemPrompt.ts`.
              return `${sanitizeForPrompt(f.label)}: sum=${sum.toLocaleString()}, avg=${avg.toFixed(2)}, min=${min}, max=${max}`;
            })
            .filter(Boolean);

          // CSV excerpt — header + first 5 rows. Both the header labels (state-derived
          // field labels) and the row cell values (live, attacker-influenceable DB data)
          // are LLM-consumed text once this summary is returned to the agentic loop, so
          // both route through `sanitizeForPrompt` before interpolation (finding T3-3) —
          // the same choke point `buildAISystemPrompt.ts` and its siblings use for every
          // other state/row-derived string in this package.
          const headers = visibleFields.map((f) => sanitizeForPrompt(f.label));
          const csvRows = rows.slice(0, 5).map((r) =>
            visibleFields.map((f) => {
              const v = r[f.id];
              return v == null ? '' : sanitizeForPrompt(v);
            }),
          );
          const csv = [headers, ...csvRows].map((row) => row.join('\t')).join('\n');

          // `widget.title`/`source.label` are model/host-settable strings echoed into a
          // markdown heading of this LLM-consumed summary — same token class
          // `buildAISystemPrompt.ts` sanitizes titles/labels for (finding T3-3).
          const label = sanitizeForPrompt(widget.title || source.label);
          const lines = [
            `### ${label} (${rowCount.toLocaleString()} rows)`,
            ...(stats.length > 0
              ? [`Stats (from ${rows.length} sample rows): ${stats.join(' | ')}`]
              : []),
            '```',
            csv,
            '```',
          ];

          // Time-series aggregation: GROUP BY query for anomaly detection and charting.
          // Skip blended charts — the y-field belongs to a different source's table.
          const isBlended =
            chartCfg !== undefined &&
            (chartCfg.ySeries ?? []).some((s) => s.sourceId && s.sourceId !== widget.sourceId);
          let tsLabels: string[] | null = null;
          let tsValues: number[] | null = null;

          if (isTimeSeries && !isBlended && chartCfg !== undefined) {
            const xField = chartCfg.xField;
            const yField =
              chartCfg.yField ?? (chartCfg.ySeries?.[0]?.fieldId as string | undefined);
            const yAgg = (chartCfg.yAggregation ?? 'sum') as
              | 'sum'
              | 'avg'
              | 'count'
              | 'min'
              | 'max';
            const xGroupBy = chartCfg.xGroupBy!;
            // Summing per-x-value aggregates into a period bucket is only valid
            // for sum/count — see ANOMALY_SAFE_AGGREGATIONS' doc comment. For
            // avg/min/max, skip the anomaly path entirely rather than feed
            // detectAnomaliesIQR a mathematically bogus combined value.
            if (xField && yField && ANOMALY_SAFE_AGGREGATIONS.has(yAgg)) {
              const aggResult = await withTimeout(
                data.queryDataSource({
                  sourceId,
                  tableName: source.tableName as string,
                  columns: [xField],
                  aggregations: [{ column: yField, func: yAgg, alias: 'y_agg' }],
                  limit: 20000,
                }),
                15_000,
                `aggregation query for ${source.tableName}`,
              );
              const grouped = new Map<string, number>();
              for (const row of aggResult.rows) {
                const periodKey = truncateToPeriod(row[xField], xGroupBy);
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
                lines.push(`Anomalies detected at: ${anomalyLabels.join(', ')}`);
              }
            }
          }

          results[i] = { text: lines.join('\n') };
        } catch (err) {
          logger?.error(
            `[mcp] summarise_page skipped widget "${widget.title || sourceId}": ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );

    const sections = results.filter((r): r is SectionItem => r != null);
    // `activePage.title` is a model-settable stored title echoed into this
    // LLM-consumed summary's heading — same token class `buildAISystemPrompt.ts`
    // sanitizes page titles for (finding T3-3). `resolvedPageId` is an internal id,
    // not model-free-text, but is included here for parity with the rest of the
    // package's sanitize-before-interpolate convention.
    const pageLabel = sanitizeForPrompt(activePage.title || resolvedPageId || 'active page');

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
    const summaryText = [`## ${pageLabel}`, ...sections.map((s) => s.text)].join('\n\n');

    return { content: [{ type: 'text' as const, text: summaryText }] };
  };
}
