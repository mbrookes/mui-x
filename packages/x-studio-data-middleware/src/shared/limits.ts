/**
 * Shared per-array size ceiling for the collection fields inside a SINGLE widget
 * descriptor or mutation descriptor (Tier3 finding — resource exhaustion).
 *
 * `MAX_WIDGETS_PER_BATCH` (`handler.ts`) and `MAX_MUTATIONS_PER_BATCH`
 * (`mutations/handleMutation.ts`) cap the NUMBER of widgets/mutations per
 * request, but neither caps the size of any single widget's/mutation's own
 * arrays — `filters`, `joins`, `columns`, `orderBy`, `aggregations`, `having`,
 * an `in`-predicate's value list, or a mutation's `where` array / `values`
 * object key count. Without a cap, a single well-formed-looking request (one
 * widget, one mutation) can still smuggle in an arbitrarily large array —
 * still unbounded work, just shaped differently from the batch-fan-out case
 * those two constants guard against.
 *
 * The value is deliberately in the same order of magnitude as
 * `MAX_WIDGETS_PER_BATCH` / `MAX_MUTATIONS_PER_BATCH` (50): 200 comfortably
 * covers any legitimate dashboard widget or mutation (a widget with 200
 * filters, columns, or joins is already a modeling smell) while still
 * rejecting a pathological, resource-exhausting payload outright.
 */
export const MAX_ARRAY_ITEMS_PER_DESCRIPTOR = 200;
