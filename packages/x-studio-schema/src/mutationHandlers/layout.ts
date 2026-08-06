/**
 * The 24-column grid arithmetic every layout write shares.
 *
 * `GRID_COLS`/`MIN_SPAN` and the span reconciliation around them are used by three unrelated
 * callers — the widget handlers, the page handlers (removing a page removes its widgets, which
 * frees their spans), and `normalizePersistedPages` at the load boundary — so they are their own
 * module rather than private to any one of them.
 *
 * The invariant all of it serves: a row's spans sum to `GRID_COLS`, no widget is narrower than
 * `MIN_SPAN`, and no span entry outlives the widget it describes.
 */
import type { StudioDoc } from '../stateTypes';
import { isSafePatchKey, shallowRecordEqual } from './shared';

/**
 * Widget column-span unit system, and the single source of truth for it.
 * `canvasGridConstants.ts` (what `StudioCanvas` renders) and `StudioController`
 * (what the drag-resize handle `setAdjacentWidgetColSpans` commits) in
 * `@mui/x-studio` both import these exact values from here.
 *
 * The dependency arrow runs `x-studio` → `x-studio-schema` (the client depends on
 * the schema package, never the reverse), so this dependency-free package is the
 * correct single home for the constant — there is no cycle risk.
 *
 * The AI `set_widget_width` tool flows through the `setWidgetColSpan` handler
 * below, so it clamps and rebalances in the SAME 24-column unit system the canvas
 * uses; a mismatched unit system would let a user drag-resize and an AI resize
 * corrupt each other's layout.
 */
export const GRID_COLS = 24;

/** Minimum column span any widget can be clamped to (~1/4 of the full row width). */
export const MIN_SPAN = Math.round(GRID_COLS / 4);

/** Clamp a widget column span to the supported `MIN_SPAN`–`GRID_COLS` range. */
export function clampSpan(span: number): number {
  // Guard non-finite input (a malformed wire payload can carry `NaN`, which would
  // otherwise survive clamping and serialize to `null` via JSON).
  if (!Number.isFinite(span)) {
    return MIN_SPAN;
  }
  return Math.max(MIN_SPAN, Math.min(GRID_COLS, Math.round(span)));
}

/**
 * Value-equality for two `widgetRows` matrices. Used by the layout handlers to honor
 * the reducer's reference-equality no-op contract: rebuilding a page with rows that
 * are element-for-element identical to the current ones must return the SAME doc so
 * `commitDocPatch`'s no-op guard skips a spurious undo entry.
 */
export function rowsEqual(a: string[][], b: string[][]): boolean {
  if (a === b) {
    return true;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    const rowA = a[i];
    const rowB = b[i];
    if (rowA.length !== rowB.length) {
      return false;
    }
    for (let j = 0; j < rowA.length; j += 1) {
      if (rowA[j] !== rowB[j]) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Value-equality for two `widgetColSpans` records (either may be `undefined`).
 * `enforceLayoutColSpans` and the `setWidgetColSpan` rebuild both mint a fresh object
 * even when the contents are unchanged, so the layout handlers compare by value (not
 * reference) to detect a no-op and preserve the same-doc contract. The
 * `undefined`-tolerant wrapper over the shared {@link shallowRecordEqual} core.
 */
export function spansEqual(
  a: Record<string, number> | undefined,
  b: Record<string, number> | undefined,
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return shallowRecordEqual(a, b);
}

/**
 * Drop duplicate widget ids from a layout matrix — first occurrence wins, across the
 * WHOLE matrix (a duplicate within a single row OR spread across rows). A widget id
 * appearing twice renders the same widget twice (a duplicate React key in
 * `StudioCanvas`) and double-counts its span in `enforceLayoutColSpans`'s overflow sum
 * (e.g. `[['w1','w1']]` with `w1: 13` sums to 26 > 24 and would delete a valid span).
 * Rows left empty after de-duplication are dropped. Callers pair this with the
 * phantom-id filter in their existing sanitization pass, so the layout handlers reject
 * both unknown ids and duplicates in one place.
 */
export function dedupeLayoutRows(rows: string[][]): string[][] {
  const seen = new Set<string>();
  const result: string[][] = [];
  for (const row of rows) {
    const deduped: string[] = [];
    for (const id of row) {
      if (!seen.has(id)) {
        seen.add(id);
        deduped.push(id);
      }
    }
    if (deduped.length > 0) {
      result.push(deduped);
    }
  }
  return result;
}

/**
 * Rebuild a page with `overrides` applied and its `widgetColSpans` set to `spans` — or,
 * when `spans` is `undefined`, with the KEY DELETED rather than written as an explicit
 * `undefined`.
 *
 * The ONE implementation of that convention for `widgetColSpans`, shared by every site
 * that installs a span map (`stripWidgetIdsFromPages`, `removeWidgetIds`,
 * `normalizePersistedPages`, `setWidgetLayout`, `setWidgetColSpan`, `applyBulkUpdate`).
 * `removeSpanEntries` and `enforceLayoutColSpans` both correctly COLLAPSE an emptied map
 * to `undefined`, but their callers then re-materialized it as an own key via
 * `{ ...page, widgetColSpans: nextSpans }` — contradicting this file's own stated rule
 * (see {@link pruneDependsOn}: "'Drops' means the KEY is `delete`d … not spread as an
 * explicit `undefined`"), so `Object.keys(page)` and `'widgetColSpans' in page` both still
 * reported a span map on a page that has none. Nothing observes the difference today only
 * because `JSON.stringify` erases it at the persistence boundary.
 */
export function withSpans(
  page: StudioDoc['pages'][string],
  spans: Record<string, number> | undefined,
  overrides?: Partial<StudioDoc['pages'][string]>,
): StudioDoc['pages'][string] {
  const next = { ...page, ...overrides };
  if (spans === undefined) {
    delete next.widgetColSpans;
  } else {
    next.widgetColSpans = spans;
  }
  return next;
}

/**
 * Remove the given widget ids' entries from a page's `widgetColSpans`, collapsing
 * an emptied map to `undefined`. Returns the same reference when no entry matched
 * (so callers can skip rebuilding the page). `ids` is looked up via a `Set` so an
 * untrusted id (`'constructor'`, `'__proto__'`) can never reach into the record's
 * prototype chain. Shared by `removeWidget` (its own span + orphaned sole-occupant
 * spans) and `applyBulkUpdate` (removed widgets' stale spans on other pages).
 *
 * The rebuild also screens each surviving KEY with `isSafePatchKey`, the way every other
 * key-by-key `Record` rebuild in this package does (`normalizePersistedPages`' span
 * rebuild, `applyBulkUpdate`'s `clampedSpans`, `updateWidget`'s config patch loop,
 * `stripUnsafeOwnKeys`). Defense in depth rather than a live vector: the one producer of
 * an unscreened `pages` map is the public `Studio initialState` prop, which
 * `createDefaultStudioState({ doc: { pages } })` installs verbatim, and a `__proto__` span
 * key from there would be copied into a fresh record by `rest[key] = …` — re-prototyping it
 * instead of adding an own key.
 */
export function removeSpanEntries(
  spans: Record<string, number> | undefined,
  ids: Iterable<string>,
): Record<string, number> | undefined {
  if (!spans) {
    return spans;
  }
  const idSet = ids instanceof Set ? (ids as Set<string>) : new Set(ids);
  let changed = false;
  const rest: Record<string, number> = {};
  for (const key of Object.keys(spans)) {
    if (idSet.has(key) || !isSafePatchKey(key)) {
      changed = true;
    } else {
      rest[key] = spans[key];
    }
  }
  if (!changed) {
    return spans;
  }
  return Object.keys(rest).length > 0 ? rest : undefined;
}

/**
 * Decides whether a span may be persisted for one row member.
 *
 * Named rather than inlined in `rebalanceRowSpans`' signature so its own parameter is
 * documented here, on the callback, instead of being attributed to the enclosing function.
 *
 * @param {string} id A row member whose span is about to be written.
 * @returns {boolean} `true` when that id is a real widget safe to persist a span for.
 */
export type CanWriteSpan = (id: string) => boolean;

/**
 * Fit ONE layout row's column spans inside `GRID_COLS`, in place, around the spans a
 * mutation explicitly asked for.
 *
 * `anchorIds` are the row members whose span this mutation is setting; every other member
 * of `rowIds` is an ABSORBER whose stored span may be reduced or cleared to make room. The
 * resolution, in order:
 *
 *  - **anchors overflow on their own** (a payload naming several widths in one row that sum
 *    past `GRID_COLS`): grant each anchor, in row order, as much of the row budget as is
 *    left, and clear the span of any anchor that cannot be granted at least `MIN_SPAN`.
 *  - **exactly one absorber**: it takes the remainder, or loses its span entirely when the
 *    remainder is below `MIN_SPAN` (a sub-minimum span is not a legal width).
 *  - **two or more absorbers**: there is no non-arbitrary way to split the remainder
 *    between them, so all their spans are cleared and the row falls back to equal flex for
 *    them.
 *
 * A span is only ever WRITTEN for an id `canWriteSpan` accepts, so a row-mate that is not a
 * real widget (or carries a prototype-hazard key) can never receive a persisted span.
 *
 * Shared by the two write paths that set a widget's width — `setWidgetColSpan` and
 * `applyBulkUpdate`'s col-spans merge — so an AI `set_widget_width` and an
 * `apply_bulk_update` carrying the same width resolve a row overflow identically. Without
 * it the bulk path fell through to `enforceLayoutColSpans`' drop-EVERY-span-in-the-row
 * rule, which discards the widths of widgets the payload never mentioned.
 */
export function rebalanceRowSpans(
  spans: Record<string, number>,
  rowIds: readonly string[],
  anchorIds: ReadonlySet<string>,
  canWriteSpan: CanWriteSpan,
): void {
  // `Object.hasOwn` per id (not `spans[id] ?? 0`) so an untrusted row id reads 0, never an
  // `Object` prototype member (which would poison the sums below with `NaN`).
  const readSpan = (id: string) => (Object.hasOwn(spans, id) ? spans[id] : 0);
  const anchorRowIds = rowIds.filter((id) => anchorIds.has(id));
  const absorberIds = rowIds.filter((id) => !anchorIds.has(id));
  let anchorTotal = anchorRowIds.reduce((sum, id) => sum + readSpan(id), 0);
  if (anchorTotal > GRID_COLS) {
    let budget = GRID_COLS;
    for (const id of anchorRowIds) {
      const granted = Math.min(readSpan(id), budget);
      if (granted >= MIN_SPAN && canWriteSpan(id)) {
        spans[id] = granted;
        budget -= granted;
      } else {
        delete spans[id];
      }
    }
    anchorTotal = GRID_COLS - budget;
  }
  const absorberTotal = absorberIds.reduce((sum, id) => sum + readSpan(id), 0);
  if (anchorTotal + absorberTotal <= GRID_COLS) {
    return;
  }
  const remaining = GRID_COLS - anchorTotal;
  if (absorberIds.length === 1 && remaining >= MIN_SPAN) {
    if (canWriteSpan(absorberIds[0])) {
      spans[absorberIds[0]] = remaining;
    }
    return;
  }
  for (const id of absorberIds) {
    delete spans[id];
  }
}

/**
 * Enforce the col-span invariants a fresh `widgetRows` layout must satisfy, given
 * the layout it replaced. This reducer is the SOLE implementation of the col-span
 * invariants: every layout path — user drag/drop, keyboard reorder, and AI-driven
 * `setWidgetLayout`/`applyBulkUpdate` — reaches them through here. Three invariants:
 *
 *  - **2→1 collapse:** a widget left alone in a row that it previously shared with
 *    others has a stale multi-widget-era span, so its span is cleared (mirrors
 *    `removeWidget`'s sole-occupant handling). A widget that was *already* a lone
 *    occupant keeps its intentional span (e.g. an AI `set_widget_width` narrowing).
 *  - **row overflow:** a row whose members' spans sum to more than `GRID_COLS` is
 *    invalid; with no explicit anchor to rebalance around, every span in that row
 *    is dropped so it falls back to equal flex distribution — matching
 *    `setWidgetColSpan`'s multi-other-widget overflow branch (which drops all
 *    sibling spans rather than inventing new clamping).
 *  - **orphaned span:** a span for a widget no longer present in this page's rows
 *    is dead weight and is dropped.
 */
export function enforceLayoutColSpans(
  oldRows: string[][],
  newRows: string[][],
  spans: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!spans) {
    return spans;
  }
  const oldRowLenByWidget = new Map<string, number>();
  for (const row of oldRows) {
    for (const id of row) {
      oldRowLenByWidget.set(id, row.length);
    }
  }
  const next: Record<string, number> = { ...spans };
  const present = new Set<string>();
  for (const row of newRows) {
    for (const id of row) {
      present.add(id);
    }
    if (row.length === 1) {
      const id = row[0];
      // Clear a survivor's stale span only when its row actually collapsed from
      // several widgets to one — never a pre-existing intentional singleton span.
      if (Object.hasOwn(next, id) && (oldRowLenByWidget.get(id) ?? 1) >= 2) {
        delete next[id];
      }
    } else if (row.length >= 2) {
      const sum = row.reduce((acc, id) => acc + (Object.hasOwn(next, id) ? next[id] : 0), 0);
      if (sum > GRID_COLS) {
        for (const id of row) {
          delete next[id];
        }
      }
    }
  }
  for (const id of Object.keys(next)) {
    if (!present.has(id)) {
      delete next[id];
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
