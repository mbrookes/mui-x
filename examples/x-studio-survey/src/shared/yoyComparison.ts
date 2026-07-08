/**
 * Pure aggregation logic for year-over-year survey comparison widgets, shared between the
 * client (`SurveyYoyComparison.tsx`, for rendering) and the widget config (`yoyPairs.ts`, for the
 * curated field/category mappings) so the two never drift apart.
 *
 * The 2023 and 2025 surveys never share an identically-worded question or an identically-labeled
 * set of answer options — question wording, option wording, and even bucket boundaries (e.g.
 * team-size ranges) all shifted between waves. `YoyFieldPair.map2023`/`map2025` translate each
 * year's raw answer strings onto a common canonical category set; anything not in the map is
 * either dropped (`dropUnmapped: true` — e.g. a 2025-only "N/A" option with no 2023 analog) or
 * folded into an "Other" bucket, so the two years become comparable percentages.
 */

export interface YoyFieldPair {
  id: string;
  /** Display title for the widget/chart. */
  title: string;
  /** 2023 data source field id (see `FIELDS` equivalent — 2023 has no named constants). */
  field2023: string;
  /** 2025 data source field id (see `FIELDS` in `surveyData.ts`). */
  field2025: string;
  /** Raw 2023 answer string -> canonical category. Unlisted raw values are dropped/"Other". */
  map2023: Record<string, string>;
  /** Raw 2025 answer string -> canonical category. Unlisted raw values are dropped/"Other". */
  map2025: Record<string, string>;
  /** Canonical categories, in display order (drives both axis order and line order). */
  categoryOrder: string[];
  /**
   * When true, a raw answer with no entry in the map is excluded from both the numerator and
   * denominator (use for "not applicable" options that only exist in one year, so they don't
   * silently inflate an "Other" bucket). When false (default), unmapped answers fold into
   * "Other" — `categoryOrder` must then include `'Other'`.
   */
  dropUnmapped?: boolean;
  /** Free-text caveat shown in the widget (e.g. an approximated bucket-boundary remap). */
  caveat?: string;
}

export interface YoyComparisonResult {
  categories: string[];
  pct2023: number[];
  pct2025: number[];
  n2023: number;
  n2025: number;
}

function bucket(
  rows: Record<string, unknown>[],
  field: string,
  map: Record<string, string>,
  dropUnmapped: boolean,
): { counts: Map<string, number>; total: number } {
  const counts = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    const raw = row[field];
    if (raw == null || String(raw).trim() === '') {
      continue;
    }
    const canonical = map[String(raw)] ?? (dropUnmapped ? null : 'Other');
    if (canonical == null) {
      continue;
    }
    counts.set(canonical, (counts.get(canonical) ?? 0) + 1);
    total += 1;
  }
  return { counts, total };
}

/**
 * Computes each canonical category's share (%) of respondents in each year. Categories with zero
 * respondents in BOTH years are dropped; a category present in only one year still renders (as a
 * 0% point in the other), since a bucket disappearing/appearing is itself informative.
 */
export function computeYoyComparison(
  rows2023: Record<string, unknown>[],
  rows2025: Record<string, unknown>[],
  pair: YoyFieldPair,
): YoyComparisonResult {
  const dropUnmapped = pair.dropUnmapped ?? false;
  const b2023 = bucket(rows2023, pair.field2023, pair.map2023, dropUnmapped);
  const b2025 = bucket(rows2025, pair.field2025, pair.map2025, dropUnmapped);

  const categories = pair.categoryOrder.filter(
    (cat) => (b2023.counts.get(cat) ?? 0) > 0 || (b2025.counts.get(cat) ?? 0) > 0,
  );

  const pct2023 = categories.map((cat) =>
    b2023.total > 0 ? ((b2023.counts.get(cat) ?? 0) / b2023.total) * 100 : 0,
  );
  const pct2025 = categories.map((cat) =>
    b2025.total > 0 ? ((b2025.counts.get(cat) ?? 0) / b2025.total) * 100 : 0,
  );

  return { categories, pct2023, pct2025, n2023: b2023.total, n2025: b2025.total };
}
