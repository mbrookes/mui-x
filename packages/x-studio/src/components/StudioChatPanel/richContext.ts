/**
 * Builds the "rich context" attached to each AI chat request.
 *
 * This is purely additive signal that helps the model answer better without any
 * user effort: per-field summary statistics, the active page's widget layout and
 * cross-filter graph, and a compact log of recent user mutations.
 *
 * All statistics are computed client-side from live pipeline-filtered rows, so
 * raw data never leaves the browser — only aggregates do. A token budget bounds
 * the payload: sections are included in priority order
 * (`fieldStats` > `pageLayout` > `recentMutations`) and anything that doesn't fit
 * is dropped, with the dropped section names recorded in `omitted`.
 */
import type {
  StudioState,
  StudioDataField,
  StudioFilterState,
  StudioAIRichContext,
  StudioAIFieldStat,
  StudioAIPageLayout,
  StudioAILayoutWidget,
  StudioAICrossFilterEdge,
} from '../../models';
import { createStudioPipeline } from '../../internals/StudioPipeline';
import { fieldHasCapability } from '../../utils/fieldCapabilities';
import type { StudioController } from '../../store/StudioController';
import { numericStats } from './generateInsight';

/** Default per-request budget (in estimated tokens) for the rich context block. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 4000;

/** Hard cap on rows sampled per source when computing field statistics. */
const MAX_STATS_ROWS = 2000;

/**
 * Synthetic widget id used to resolve page-scoped rows for a source without
 * binding to a real widget. Because it matches no widget, `selectFiltersForWidget`
 * applies page, date-range, cross-filter, and interactive filters (the live view)
 * but never widget-scoped filters — exactly what we want for per-source stats.
 */
const SYNTHETIC_WIDGET_ID = '__rich_context__';

export interface BuildRichContextOptions {
  /** Token budget for the whole rich-context payload. @default DEFAULT_CONTEXT_TOKEN_BUDGET */
  budgetTokens?: number;
}

/** Cheap token estimate: ~4 chars per token over the JSON encoding. */
function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value).length / 4);
}

/** Even stride sample down to at most `max` rows (keeps head/tail coverage). */
function strideSample<T>(rows: T[], max: number): T[] {
  if (rows.length <= max) {
    return rows;
  }
  const stride = Math.ceil(rows.length / max);
  const out: T[] = [];
  for (let i = 0; i < rows.length; i += stride) {
    out.push(rows[i]);
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compute a single field's statistic from a sampled row set, or `null` to skip. */
function computeFieldStat(
  field: StudioDataField,
  sample: Record<string, unknown>[],
): StudioAIFieldStat | null {
  // Skip fields that never materialise in the data (e.g. unmapped columns).
  if (!sample.some((r) => field.id in r)) {
    return null;
  }
  if (fieldHasCapability(field, 'numeric')) {
    const values = sample
      .map((r) => r[field.id])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const stats = numericStats(values);
    if (!stats) {
      return null;
    }
    return {
      type: field.type,
      min: stats.min,
      max: stats.max,
      mean: round2(stats.mean),
      sampledRows: sample.length,
    };
  }
  const distinct = new Set<string>();
  for (const r of sample) {
    const v = r[field.id];
    if (v !== null && v !== undefined) {
      distinct.add(String(v));
    }
  }
  return { type: field.type, distinctCount: distinct.size, sampledRows: sample.length };
}

/** Build per-field statistics for every visible field across all data sources. */
function buildFieldStats(state: StudioState): Record<string, StudioAIFieldStat> {
  const pipeline = createStudioPipeline(state);
  const activePageId = state.dashboard.activePageId;
  const stats: Record<string, StudioAIFieldStat> = {};

  for (const source of Object.values(state.dataSources)) {
    if (source.hidden) {
      continue;
    }
    const rawRows = source.rows;
    if (!rawRows || rawRows.length === 0) {
      continue; // adapter-backed sources have no local rows
    }
    const filtered = pipeline.resolveWidgetRows(
      SYNTHETIC_WIDGET_ID,
      source.id,
      rawRows,
      activePageId,
    );
    const sample = strideSample(filtered, MAX_STATS_ROWS);
    for (const field of source.fields) {
      if (field.hidden) {
        continue;
      }
      const stat = computeFieldStat(field, sample);
      if (stat) {
        stats[`${source.id}.${field.id}`] = stat;
      }
    }
  }
  return stats;
}

/** Build the active page's widget layout and cross-filter graph. */
function buildPageLayout(state: StudioState): StudioAIPageLayout | undefined {
  const pageId = state.dashboard.activePageId;
  const page = state.pages[pageId];
  if (!page) {
    return undefined;
  }

  const rows: StudioAILayoutWidget[][] = (page.widgetRows ?? []).map((row) =>
    row.flatMap((widgetId) => {
      const w = state.widgets[widgetId];
      if (!w) {
        return [];
      }
      const entry: StudioAILayoutWidget = {
        widgetId,
        kind: w.kind,
        title: w.title ?? '',
      };
      const chartType = (w.config as { chartType?: string } | undefined)?.chartType;
      if (chartType) {
        entry.chartType = chartType;
      }
      const colSpan = page.widgetColSpans?.[widgetId];
      if (colSpan != null) {
        entry.colSpan = colSpan;
      }
      return [entry];
    }),
  );

  const crossFilters: StudioAICrossFilterEdge[] = state.filters.flatMap((f: StudioFilterState) => {
    if (
      (f.scope.kind === 'cross-filter' || f.scope.kind === 'interactive') &&
      f.scope.pageId === pageId &&
      !f.disabled
    ) {
      return [{ sourceWidgetId: f.scope.sourceWidgetId, field: f.field, scope: f.scope.kind }];
    }
    return [];
  });

  return { pageId, rows, crossFilters };
}

/** True when a page layout carries no widgets and no cross-filter edges. */
function isEmptyLayout(layout: StudioAIPageLayout): boolean {
  return layout.rows.every((row) => row.length === 0) && layout.crossFilters.length === 0;
}

/**
 * Assembles the rich AI context, dropping the lowest-priority sections that don't
 * fit the token budget. The `fieldStats` section is itself truncated field-by-field
 * (numeric fields kept first) when it alone would exceed the remaining budget.
 *
 * Returns `undefined` when there is nothing meaningful to send.
 */
export function buildRichContext(
  state: StudioState,
  controller: Pick<StudioController, 'getRecentMutations'>,
  options: BuildRichContextOptions = {},
): StudioAIRichContext | undefined {
  const budget = options.budgetTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET;

  const fieldStats = buildFieldStats(state);
  const pageLayout = buildPageLayout(state);
  const recentMutations = controller.getRecentMutations();

  const result: StudioAIRichContext = {};
  const omitted: string[] = [];
  let running = 0;

  // 1. fieldStats (highest priority) — truncate field-by-field if needed.
  const statEntries = Object.entries(fieldStats);
  if (statEntries.length > 0) {
    const full = estimateTokens(fieldStats);
    if (running + full <= budget) {
      result.fieldStats = fieldStats;
      running += full;
    } else {
      // Greedily include fields (numeric first) until the budget is exhausted.
      const ordered = statEntries.sort(
        (a, b) =>
          Number(b[1].min !== undefined || b[1].max !== undefined) -
          Number(a[1].min !== undefined || a[1].max !== undefined),
      );
      const reduced: Record<string, StudioAIFieldStat> = {};
      let included = 0;
      for (const [key, stat] of ordered) {
        const next = { ...reduced, [key]: stat };
        if (running + estimateTokens(next) > budget) {
          break;
        }
        reduced[key] = stat;
        included += 1;
      }
      if (included > 0) {
        result.fieldStats = reduced;
        running += estimateTokens(reduced);
        omitted.push(
          `fieldStats(${statEntries.length - included} of ${statEntries.length} fields)`,
        );
      } else {
        omitted.push('fieldStats');
      }
    }
  }

  // 2. pageLayout (skipped entirely when the page has no widgets or cross-filters)
  if (pageLayout && !isEmptyLayout(pageLayout)) {
    const cost = estimateTokens(pageLayout);
    if (running + cost <= budget) {
      result.pageLayout = pageLayout;
      running += cost;
    } else {
      omitted.push('pageLayout');
    }
  }

  // 3. recentMutations (lowest priority)
  if (recentMutations.length > 0) {
    const cost = estimateTokens(recentMutations);
    if (running + cost <= budget) {
      result.recentMutations = recentMutations;
      running += cost;
    } else {
      omitted.push('recentMutations');
    }
  }

  if (omitted.length > 0) {
    result.omitted = omitted;
  }

  // Nothing worth sending.
  if (!result.fieldStats && !result.pageLayout && !result.recentMutations && omitted.length === 0) {
    return undefined;
  }
  return result;
}
