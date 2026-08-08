/**
 * Which fields to offer first when a picker asks for one.
 *
 * The compose drawer already filters pickers by CAPABILITY — only temporal fields appear in a
 * date-group selector, only numeric ones in a measure selector (`utils/fieldCapabilities.ts`). That
 * answers "which fields are legal here". It does not answer "which one did you probably mean",
 * which is the question a user faces on a source with forty columns, and the one
 * AG_STUDIO_GAP_ANALYSIS XS-EDIT-003 is about.
 *
 * ## What this is allowed to know
 *
 * Field metadata only — id, label, type. Not row data. A cardinality-aware suggestion would be
 * better ("prefer the categorical field with 5 distinct values over the one with 40,000"), but the
 * pickers render before any query has run, and blocking a picker on a distinct-value scan to
 * improve an ORDERING would be a bad trade. So this is a naming and typing heuristic, and it is
 * worth being plain about that: it reorders, it never filters.
 *
 * ## Why reordering rather than filtering
 *
 * A wrong suggestion costs a user one glance. A wrong exclusion costs them the ability to build
 * what they wanted, with no indication of why the field is missing. Everything stays in the list;
 * the suggestions are a group at the top.
 */
import type { StudioDataField } from '../models';
import { getFieldCapabilities } from '../utils/fieldCapabilities';

/** The role a picker is filling. */
export type FieldMappingRole =
  /** A grouping axis — a chart's x-axis, a grid's group-by. */
  | 'dimension'
  /** A quantity to aggregate — a chart's y-axis, a KPI's value. */
  | 'measure'
  /** A time axis. */
  | 'temporal';

/**
 * Name fragments that read as a QUANTITY.
 *
 * Matched against the id and the label, because a source can carry a technical id with a human
 * label (`col_7` / "Revenue") or the reverse.
 */
const MEASURE_HINTS = [
  'amount',
  'total',
  'revenue',
  'sales',
  'price',
  'cost',
  'value',
  'qty',
  'quantity',
  'count',
  'sum',
  'profit',
  'margin',
  'balance',
  'score',
  'rating',
  'duration',
  'weight',
];

/**
 * Name fragments that read as an IDENTIFIER rather than a value.
 *
 * The most useful half of this heuristic, and the least obvious. An id column is numeric, so a
 * type-only rule offers `order_id` as a measure — and summing order ids is the canonical
 * meaningless dashboard. The same names are demoted as dimensions: an id is high-cardinality by
 * definition, so grouping by one produces a chart with one bar per row.
 */
const IDENTIFIER_HINTS = ['id', 'uuid', 'guid', 'key', 'code', 'ref', 'hash', 'index', 'zip'];

/** Name fragments that read as a PRIMARY date, when a source has several. */
const PRIMARY_DATE_HINTS = ['date', 'created', 'timestamp', 'time', 'occurred', 'ordered'];

/**
 * True when any hint appears in the field's id or label, as a whole word or a delimited segment.
 *
 * Segment-aware rather than a bare `includes`, because `includes('id')` matches "video", "width"
 * and "identity" — which would demote three perfectly good dimensions on the strength of a
 * substring.
 * @param field The field to test.
 * @param hints The fragments to look for.
 * @returns Whether the field's naming matches.
 */
function nameMatches(field: StudioDataField, hints: readonly string[]): boolean {
  const segments = `${field.id} ${field.label ?? ''}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return hints.some((hint) => segments.includes(hint));
}

/**
 * Score a field for a role. Higher is offered sooner; a negative score is never suggested.
 * @param field The candidate.
 * @param role The role being filled.
 * @returns The score.
 */
function scoreForRole(field: StudioDataField, role: FieldMappingRole): number {
  const capabilities = getFieldCapabilities(field);
  const looksLikeIdentifier = nameMatches(field, IDENTIFIER_HINTS);

  if (role === 'temporal') {
    if (!capabilities.includes('temporal')) {
      return -1;
    }
    return nameMatches(field, PRIMARY_DATE_HINTS) ? 2 : 1;
  }

  if (role === 'measure') {
    if (!capabilities.includes('numeric')) {
      return -1;
    }
    // An id-shaped numeric column is legal here and almost never meant. Ranked below every other
    // numeric field rather than excluded, because a source whose only numeric column is `code`
    // should still suggest something.
    if (looksLikeIdentifier) {
      return 0;
    }
    return nameMatches(field, MEASURE_HINTS) ? 2 : 1;
  }

  if (!capabilities.includes('categorical')) {
    return -1;
  }
  // Grouping by an identifier yields one bucket per row — technically a chart, practically a
  // wall. Same treatment as the measure case: demoted, not hidden.
  if (looksLikeIdentifier) {
    return 0;
  }
  // A boolean is the lowest-cardinality dimension there is, so it is a safe first offer.
  return field.type === 'boolean' ? 2 : 1;
}

/**
 * The field ids to offer first for a role, best first.
 *
 * Ties keep the source's own field order, which is the order the author declared and therefore the
 * closest thing to an intentional ranking that exists.
 * @param fields The candidate fields, already filtered to what the picker allows.
 * @param role The role being filled.
 * @param limit How many to suggest. Kept small on purpose: a "suggested" group of ten is a second
 *   copy of the list, and reading it costs the user the time the suggestion was meant to save.
 * @returns Field ids, best first. Empty when nothing scores above zero.
 */
export function suggestFieldsForRole(
  fields: readonly StudioDataField[],
  role: FieldMappingRole,
  limit = 3,
): string[] {
  return fields
    .map((field, index) => ({ field, index, score: scoreForRole(field, role) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((entry) => entry.field.id);
}
