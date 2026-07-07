/**
 * AI-insight context for the `survey-rank-heatmap` custom widget.
 *
 * The widget's underlying field holds a comma-separated, rank-ordered list per respondent
 * (e.g. "Dashboards, Alerting, Reports") — not a plain categorical/numeric column. The
 * generic `query_data_source` / `execute_query` tools can't parse that into per-category,
 * per-rank counts, so an insight request would leave the model guessing. Instead, this
 * enricher computes the exact same rank matrix the widget renders (via the shared
 * `computeRankMatrix`) directly from the DB and injects the numbers into the AI's context.
 */
import type knex from 'knex';
import type { StudioState } from '@mui/x-studio-ai-middleware';
import { computeRankMatrix } from '../shared/rankMatrix.js';

type Db = ReturnType<typeof knex>;

/**
 * Builds a text summary of every `survey-rank-heatmap` widget present in `dashboardState`, or
 * `null` when there are none (or none could be resolved against the known schema).
 */
export async function summarizeRankHeatmaps(
  db: Db,
  dashboardState: StudioState,
  schema: Map<string, Set<string>>,
): Promise<string | null> {
  const widgets = Object.values(dashboardState.doc.widgets ?? {}).filter(
    (w) => w.kind === 'survey-rank-heatmap',
  );
  if (widgets.length === 0) {
    return null;
  }

  const summaries: string[] = [];
  for (const widget of widgets) {
    const source = widget.sourceId
      ? dashboardState.runtime.dataSources[widget.sourceId]
      : undefined;
    const tableName = source?.tableName;
    const field = (widget.config.customConfig as { field?: string } | undefined)?.field;
    if (!tableName || !field || !schema.get(tableName)?.has(field)) {
      continue;
    }

    try {
      // eslint-disable-next-line no-await-in-loop -- summaries are independent but few (one per
      // heatmap widget on the dashboard), so sequential queries keep this simple to reason about.
      const rows = (await db(tableName).select(field)) as Record<string, unknown>[];
      const { categories, meanRanks, matrix, rankCount } = computeRankMatrix(rows, field);
      if (categories.length === 0) {
        continue;
      }
      const respondentCount = rows.filter(
        (r) => r[field] != null && String(r[field]).trim() !== '',
      ).length;

      const lines = categories.map((category, i) => {
        const topRankCount = matrix[i][0] ?? 0;
        return `  - "${category}": mean rank ${meanRanks[i].toFixed(2)}, ranked #1 (most important) by ${topRankCount} of ${respondentCount} respondents`;
      });
      summaries.push(
        `Widget "${widget.title}" (id: ${widget.id}, kind: survey-rank-heatmap) — ${respondentCount} respondents ranked ${categories.length} categories across ${rankCount} positions (1 = most important, ${rankCount} = least important). Categories ordered most→least important by mean rank:\n${lines.join('\n')}`,
      );
    } catch {
      // Best-effort: skip this widget's summary on any query failure so one bad widget
      // doesn't break AI context for the rest of the dashboard.
    }
  }

  return summaries.length > 0 ? summaries.join('\n\n') : null;
}
