import { GRID_COLS } from '@mui/x-studio-schema';
import { lookup } from '../../utils/safeLookup';

/**
 * ONE meaning for a missing `page.widgetColSpans` entry, for the whole canvas.
 *
 * A page's `widgetColSpans` is SPARSE: a widget that was never explicitly resized has no
 * entry at all. Before this module, four sites disagreed about what that absence meant —
 * the edit-mode flex-grow and the resize-pair default both substituted
 * `round(GRID_COLS / row.length)`, view mode fell through to `flex: 1` (auto, NOT a
 * percentage basis), and the reducer's row-overflow sweep counts it as `0`. The
 * disagreement was visible: a row like `{A: 16, B: 8}` plus an unspanned `C` sums to
 * `16 + 0 + 8 = 24` under the reducer, so `enforceLayoutColSpans` left it alone; edit mode
 * then rendered three across (C at the `round(24/3) = 8` default) while view mode wrapped C
 * onto its own line, because A and B consumed exactly 100% via their percentage bases and C
 * fell to `flex: 1` under `flexWrap: 'wrap'`.
 *
 * The meaning settled on here, used by EVERY canvas consumer:
 *
 *   **A missing entry means "an equal share of the row": `round(GRID_COLS / row.length)`.**
 *
 * It is the meaning three of the four sites already assumed, so a well-formed row renders
 * byte-identically to before. {@link resolveRowColSpans} then adds the piece that was
 * missing everywhere: the resolved row is scaled back down when it would overflow
 * `GRID_COLS`, so no canvas consumer can ever see an over-budget row — whatever the doc
 * says.
 *
 * The reducer's own `0` accounting is NOT changed here (it lives in the schema package and
 * governs what is PERSISTED, not what is rendered). {@link resolveResizePair} bridges the
 * two: it caps what a resize may commit using the reducer's accounting, so the two
 * meanings can never again disagree about whether a row fits.
 */
export function defaultColSpan(rowLength: number): number {
  if (rowLength <= 0) {
    return GRID_COLS;
  }
  return Math.round(GRID_COLS / rowLength);
}

/**
 * The EXPLICIT column span stored for `widgetId`, or `null` when the widget has no entry.
 *
 * `widgetColSpans` is doc-authored and keyed by widget id, so it is indexed through the
 * prototype-chain-safe `lookup`: an id named after an `Object.prototype` member
 * ("constructor"/"toString"/…) must resolve to "no entry" rather than an inherited function
 * that `??` never replaces and that poisons every span computation into `NaN`. A
 * non-finite or non-positive stored value (a hostile or hand-edited persisted doc) is
 * likewise reported as "no entry" rather than propagated.
 */
export function storedColSpan(
  widgetColSpans: Record<string, number> | undefined,
  widgetId: string,
): number | null {
  const raw = lookup(widgetColSpans, widgetId);
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return null;
  }
  return raw;
}

/**
 * Scale `spans` down so they sum to `budget`, using largest-remainder rounding so the
 * result sums to EXACTLY `budget` (plain per-entry rounding does not). Every entry keeps
 * at least one column, so a widget is never resolved to zero width.
 */
function scaleDownToBudget(spans: number[], total: number, budget: number): number[] {
  const exact = spans.map((span) => (span * budget) / total);
  const result = exact.map((value) => Math.max(1, Math.floor(value)));
  let used = result.reduce((acc, value) => acc + value, 0);
  // `sum(floor(exact)) >= budget - spans.length`, so at most one pass of +1s is ever needed.
  const byRemainder = exact
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < byRemainder.length && used < budget; i += 1) {
    result[byRemainder[i].index] += 1;
    used += 1;
  }
  return result;
}

/**
 * Effective column span for every widget in `row`, in row order.
 *
 * Missing entries take {@link defaultColSpan}. The result is then guaranteed to sum to at
 * most `GRID_COLS`: a row whose resolved spans overflow (only reachable from a doc the
 * reducer's `0`-accounting let through, or a hand-edited one) is scaled down proportionally
 * rather than rendered overflowing. An UNDER-budget row is deliberately left alone — a lone
 * widget with an explicit span of 6 is a quarter-width widget, not a full-width one, and
 * `enforceLayoutColSpans` likewise only ever objects to a row that sums OVER `GRID_COLS`.
 */
export function resolveRowColSpans(
  row: readonly string[],
  widgetColSpans: Record<string, number> | undefined,
): number[] {
  if (row.length === 0) {
    return [];
  }
  const fallback = defaultColSpan(row.length);
  const spans = row.map((widgetId) => storedColSpan(widgetColSpans, widgetId) ?? fallback);
  const total = spans.reduce((acc, span) => acc + span, 0);
  if (total <= GRID_COLS) {
    return spans;
  }
  return scaleDownToBudget(spans, total, GRID_COLS);
}

export interface ResizePairSpans {
  /** Span the resize handle should present (and commit) for the widget on its left. */
  leftSpan: number;
  /** Span the resize handle should present (and commit) for the widget on its right. */
  rightSpan: number;
  /** `leftSpan + rightSpan` — the constant the handle redistributes across the drag. */
  totalSpan: number;
}

/**
 * Spans for the resize handle sitting between `row[index]` and `row[index + 1]`.
 *
 * The handle keeps the PAIR's total constant and only redistributes it, so that total is
 * the entire budget the gesture can spend — and the commit writes explicit entries for both
 * widgets while leaving every other widget in the row exactly as it was. That makes the
 * pair total the one place a resize can push a row over `GRID_COLS`, which is precisely
 * what used to happen: `setAdjacentWidgetColSpans` writes through `commitDocPatch`, NOT
 * through `applyMutation`, so the reducer's row-sum sweep never runs on a resize and an
 * over-budget row survives serialize/reload (only each span's individual clamp is
 * re-applied at load).
 *
 * So the pair total is capped at what the row can still afford UNDER THE REDUCER'S OWN
 * ACCOUNTING (a missing entry contributes `0` to the persisted row budget), floored at the
 * two widgets' combined minimums — because refusing to satisfy a minimum span is worse than
 * an over-budget row, matching `setAdjacentWidgetColSpans`/`enforceLayoutColSpans`' shared
 * "favour widening over ever committing a sub-minimum span" policy.
 *
 * In the ordinary case (every widget in the row carries an explicit span, and they fit) the
 * cap equals the pair's own total and nothing changes. It only bites on a row that is
 * already over budget, where the returned spans can be a column or two narrower than what
 * {@link resolveRowColSpans} RENDERS for the same widgets — rendering shows the row as it
 * is, this shows what may safely be written back. One resize reconciles the two.
 */
export function resolveResizePair(
  row: readonly string[],
  widgetColSpans: Record<string, number> | undefined,
  index: number,
  leftMinSpan: number,
  rightMinSpan: number,
): ResizePairSpans {
  const resolved = resolveRowColSpans(row, widgetColSpans);
  const left = resolved[index] ?? defaultColSpan(row.length);
  const right = resolved[index + 1] ?? 0;
  const rawTotal = left + right;

  let othersStoredTotal = 0;
  for (let i = 0; i < row.length; i += 1) {
    if (i !== index && i !== index + 1) {
      othersStoredTotal += storedColSpan(widgetColSpans, row[i]) ?? 0;
    }
  }
  const minTotal = leftMinSpan + rightMinSpan;
  const budget = Math.max(minTotal, GRID_COLS - othersStoredTotal);
  // Clamped from BOTH sides. The upper bound is the row's remaining budget (above); the
  // lower bound is the pair's combined minimums, which matters when the row was so
  // over-budget that `resolveRowColSpans` had to scale this pair below `MIN_SPAN` — a pair
  // total under its own minimums is exactly the `minLeft > maxLeft` state that wedges
  // `RowResizeHandle` permanently.
  const totalSpan = Math.min(budget, Math.max(minTotal, rawTotal));
  const scaledLeft = rawTotal > 0 ? Math.round((left * totalSpan) / rawTotal) : leftMinSpan;
  // `totalSpan - rightMinSpan >= leftMinSpan` holds by the `minTotal` floor, so this clamp
  // is always satisfiable and can never produce a sub-minimum span on either side.
  const leftSpan = Math.max(leftMinSpan, Math.min(totalSpan - rightMinSpan, scaledLeft));
  return { leftSpan, rightSpan: totalSpan - leftSpan, totalSpan };
}
