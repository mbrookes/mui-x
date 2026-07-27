/**
 * Shared per-array size ceiling for the collection fields inside a SINGLE widget
 * descriptor or mutation descriptor (Tier3 finding — resource exhaustion).
 *
 * `MAX_WIDGETS_PER_BATCH` (`handler.ts`) and `MAX_MUTATIONS_PER_BATCH`
 * (`mutations/handleMutation.ts`) cap the NUMBER of widgets/mutations per
 * request, but neither caps the size of any single widget's/mutation's own
 * arrays — `filters`, `joins`, `columns`, `orderBy`, `aggregations`, `having`,
 * an `in`-predicate's value list, a mutation's `where` array / `values` object
 * key count, a single join's own `on` sub-array (`joins[].on` — Tier2 finding:
 * a nested array, not bounded by the `joins` array's own length cap above it),
 * or a widget's `columnAliases` key count (Tier2 finding: a
 * `Record<string,string>`, not an array, so it falls outside the
 * `Array.isArray` shape-guard loop and needs its own `Object.keys(...).length`
 * check). Without a cap, a single well-formed-looking request (one widget, one
 * mutation) can still smuggle in an arbitrarily large array or object — still
 * unbounded work, just shaped differently from the batch-fan-out case those
 * two constants guard against.
 *
 * The value is deliberately in the same order of magnitude as
 * `MAX_WIDGETS_PER_BATCH` / `MAX_MUTATIONS_PER_BATCH` (50): 200 comfortably
 * covers any legitimate dashboard widget or mutation (a widget with 200
 * filters, columns, joins, or column aliases is already a modeling smell)
 * while still rejecting a pathological, resource-exhausting payload outright.
 */
export const MAX_ARRAY_ITEMS_PER_DESCRIPTOR = 200;

/**
 * Hard ceiling on the length of an individual client-supplied IDENTIFIER
 * string — a table name, a column reference (qualified or not), an aggregation
 * or output alias, or a `columnAliases` key/value (Tier2 finding — resource
 * exhaustion, in a dimension `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` doesn't cover).
 *
 * Every collection field above has a cap on how MANY entries it may hold, but
 * — before this constant — not one field capped how LONG any individual string
 * entry could be. A single well-formed-SHAPE request (one widget, arrays well
 * under their count caps) could still carry, say, a 50MB string as a "table"
 * or "column" value: it would sail past every existing check, get recursively
 * serialized and hashed — up to `MAX_WIDGETS_PER_BATCH` times per request — by
 * `security/canonicalize.ts`'s `sortedStringify` (every field of every widget
 * descriptor feeds `security/cacheKey.ts`'s `computeQueryHash`), and ultimately
 * reach the database as a bound parameter or identifier that is expensive to
 * validate, hash, and compare.
 *
 * 1024 characters is deliberately generous — no legitimate table name, column
 * name, or alias approaches that length — while still rejecting a pathological
 * payload outright. See `MAX_STRING_VALUE_LENGTH` below for the separate,
 * larger bound used for scalar filter/where/mutation VALUES, which (unlike an
 * identifier) may legitimately need more headroom for real business data.
 */
export const MAX_STRING_LENGTH = 1024;

/**
 * Hard ceiling on the length of an individual client-supplied string VALUE —
 * a filter/where predicate's scalar comparison value (or an "in"-list string
 * element), and a mutation `values` string value (Tier2 finding — resource
 * exhaustion, the same dimension `MAX_STRING_LENGTH` covers for identifiers).
 *
 * Deliberately a SEPARATE, larger bound than `MAX_STRING_LENGTH`: an
 * identifier (table/column/alias) is authored by a developer and is never
 * legitimately long, but a filter/where value carries real business data (a
 * free-text search term, a long description to match, …) that may
 * legitimately need more headroom than an identifier ever would. 8192
 * characters comfortably covers realistic filter/business-data strings while
 * still rejecting a payload designed purely to bloat the cache-key hash input
 * and the bound parameter sent to the database.
 */
export const MAX_STRING_VALUE_LENGTH = 8192;

/**
 * Hard ceiling on the TOTAL number of predicate comparison values a SINGLE
 * widget/mutation descriptor may carry, summed across every one of its
 * `filters[].value` / `where[].value` entries.
 *
 * `MAX_ARRAY_ITEMS_PER_DESCRIPTOR` caps the predicate COUNT (≤ 200 filters) and
 * each individual `in`-list LENGTH (≤ 200 values) — but not their PRODUCT. One
 * well-formed-looking widget could therefore carry 200 × 200 = 40,000 bound
 * parameters, and a `MAX_WIDGETS_PER_BATCH`-sized batch 2,000,000, all of which
 * are canonicalized and hashed into the cache key and then shipped to the
 * database as bind parameters. This is the same gap `totalOnPairs`
 * (`handler.ts`) closes for `joins[].on`, applied to the value lists.
 *
 * Deliberately a SEPARATE, larger constant than `MAX_ARRAY_ITEMS_PER_DESCRIPTOR`
 * rather than reusing it: a legitimate dashboard genuinely can carry several
 * multi-select `in` filters at once (a page filter plus two cross-filters, each
 * with a long selection), and capping their SUM at 200 would reject a shape the
 * per-predicate cap already admits individually. 2,000 leaves room for ten
 * fully-maxed `in` lists per descriptor while cutting the worst case by 20× per
 * descriptor (40,000 → 2,000) and by the same factor per batch (2,000,000 →
 * 100,000).
 */
export const MAX_PREDICATE_VALUES_PER_DESCRIPTOR = 2000;
