/**
 * Data-query tool handlers for the x-studio MCP server.
 *
 * Implements the read-only data tools (`query_data_source`, `describe_data_source`,
 * `get_field_values`, `compute_field_stats`, `summarise_page`), the SVG
 * `render_chart` tool, the session-scoped `get_recent_changes` tool, and the
 * stats / anomaly-detection helpers `summarise_page` relies on.
 *
 * Each factory returns plain `ToolHandler`s; the composition root (`mcp.ts`)
 * wires them into the `tools/call` dispatch table.
 */

import { detectAnomaliesIQR, truncateToPeriod } from '@mui/x-studio-schema';
import { renderChartSvg } from '../chartRenderer';
import type { ChartRendererInput } from '../chartRenderer';
import type { StudioAIRecentMutation } from '../models/aiTypes';
import { errorResult, jsonResult, withTimeout, type ToolHandler } from './helpers';
import type {
  StudioDataFilter,
  StudioDataAggregation,
  StudioDataHavingPredicate,
  StudioDataOrderBy,
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
 */
const ANOMALY_SAFE_AGGREGATIONS = new Set(['sum', 'count']);

/** Dependencies shared by the data-query and utility tool handlers. */
export interface DataToolDeps {
  stateBox: StudioStateBox;
  /** Data-access configuration; when absent, the data tools return descriptive errors. */
  data?: StudioMcpData;
  /** Hard upper bound applied to the `query_data_source` `limit`. */
  maxQueryRows: number;
  /** Session-scoped mutation log surfaced by `get_recent_changes`. */
  recentChanges: StudioAIRecentMutation[];
  logger?: StudioMcpLogger;
}

/**
 * Build the handlers that are always registered regardless of `data`:
 * `get_recent_changes`, `render_chart`, and the data tools (which internally
 * return a descriptive error when `data` is not configured).
 */
export function createDataToolHandlers(deps: DataToolDeps): Record<string, ToolHandler> {
  const { stateBox, data, maxQueryRows, recentChanges } = deps;

  const handlers: Record<string, ToolHandler> = {
    // ── get_recent_changes — session-scoped mutation log ────────────────
    get_recent_changes: () => jsonResult({ output: recentChanges }),

    // ── render_chart — pure SVG chart rendering ───────────────────────────
    render_chart: (args) => {
      try {
        const chartInput = (args ?? {}) as unknown as ChartRendererInput;
        if (!chartInput.type) {
          return errorResult(
            '`type` is required (bar, line, pie, scatter, donut, or stacked_bar).',
          );
        }
        const svgString = renderChartSvg(chartInput);
        const base64 = Buffer.from(svgString).toString('base64');
        return {
          content: [
            {
              type: 'image' as const,
              data: base64,
              mimeType: 'image/svg+xml',
            },
            {
              type: 'text' as const,
              text: svgString,
            },
          ],
        };
      } catch (err) {
        return errorResult(String(err));
      }
    },

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

      const clampedLimit = Math.min(limit ?? maxQueryRows, maxQueryRows);

      if (!sourceId) {
        return errorResult('sourceId is required');
      }

      // Validate the sourceId against registered sources *before* building a query —
      // matching the identical check in describe_data_source / get_field_values /
      // compute_field_stats. Without it, an unknown/unregistered sourceId would fall
      // straight through as a physical table name and hit the DB, producing a raw
      // driver error (or worse, querying an unintended table) instead of this clear,
      // actionable message.
      const source = stateBox.current.dataSources[sourceId];
      if (!source || !source.tableName) {
        return errorResult(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      const tableName = source.tableName as string;

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
          ...(offset !== undefined && { offset }),
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
      const source = stateBox.current.dataSources[sourceId];
      if (!source || !source.tableName) {
        return errorResult(
          `Unknown data source: "${sourceId}". Check studio://dashboard/state for available source IDs.`,
        );
      }
      try {
        const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
        const numericFields = visibleFields.filter((f) => f.type === 'number');

        // Run sample rows and row count in parallel with per-field numeric stats.
        const [sampleResult, ...statsResults] = await Promise.all([
          data.queryDataSource({ sourceId, tableName: source.tableName as string, limit: 10 }),
          ...numericFields.map((f) =>
            data
              .queryDataSource({
                sourceId,
                tableName: source.tableName as string,
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
      const source = stateBox.current.dataSources[sourceId];
      if (!source || !source.tableName) {
        return errorResult(`Unknown data source: "${sourceId}".`);
      }
      try {
        const clampedFieldLimit = Math.min(fieldLimit ?? 50, 200);
        const result = await data.queryDataSource({
          sourceId,
          tableName: source.tableName as string,
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
              stateBox.current.dataSources[sourceId]?.fields?.find((f) => f.id === fieldId)
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
      const source = stateBox.current.dataSources[sourceId];
      if (!source || !source.tableName) {
        return errorResult(`Unknown data source: "${sourceId}".`);
      }
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
          tableName: source.tableName as string,
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

  return handlers;
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
}): ToolHandler {
  const { stateBox, data, logger } = deps;

  return async (args) => {
    const state = stateBox.current;
    // Accept optional pageId arg; fall back to active page.
    const requestedPageId = (args as { pageId?: string })?.pageId;
    const resolvedPageId = requestedPageId ?? state.dashboard.activePageId;
    const activePage = resolvedPageId ? state.pages[resolvedPageId] : null;

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
    const widgets = widgetIds.map((id) => state.widgets[id]).filter(Boolean);
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
        const source = state.dataSources[sourceId];
        if (!source?.tableName) {
          return;
        }

        const visibleFields = (source.fields ?? []).filter((f) => !f.hidden);
        const numericFields = visibleFields.filter((f) => f.type === 'number');

        try {
          const isTimeSeries =
            widget.kind === 'chart' &&
            Boolean(widget.config.xGroupBy) &&
            ANOMALY_CHART_TYPES.has(widget.config.chartType ?? 'bar');

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
              return `${f.label}: sum=${sum.toLocaleString()}, avg=${avg.toFixed(2)}, min=${min}, max=${max}`;
            })
            .filter(Boolean);

          // CSV excerpt — header + first 5 rows.
          const headers = visibleFields.map((f) => f.label);
          const csvRows = rows.slice(0, 5).map((r) =>
            visibleFields.map((f) => {
              const v = r[f.id];
              return v == null ? '' : String(v);
            }),
          );
          const csv = [headers, ...csvRows].map((row) => row.join('\t')).join('\n');

          const label = widget.title || source.label;
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
          const isBlended = (widget.config.ySeries ?? []).some(
            (s: any) => s.sourceId && s.sourceId !== widget.sourceId,
          );
          let tsLabels: string[] | null = null;
          let tsValues: number[] | null = null;

          if (isTimeSeries && !isBlended) {
            const xField = widget.config.xField;
            const yField =
              widget.config.yField ?? (widget.config.ySeries?.[0]?.fieldId as string | undefined);
            const yAgg = (widget.config.yAggregation ?? 'sum') as
              | 'sum'
              | 'avg'
              | 'count'
              | 'min'
              | 'max';
            const xGroupBy = widget.config.xGroupBy!;
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
    const pageLabel = activePage.title || resolvedPageId || 'active page';

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
