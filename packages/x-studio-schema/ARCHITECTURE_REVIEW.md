# `@mui/x-studio-schema` clean-slate review — 0/0/2

Findings tiered as `Tier1/Tier2/Tier3` = **0 / 0 / 2**.

Scope: full current source of `packages/x-studio-schema/src` (reducer, wire parser,
persistence + migrations, factories, type guards, config-key validation, temporal/anomaly
helpers, type modules). Read against `ARCHITECTURE.md`, `CLAUDE.md`, `AGENTS.md`. No tests
run; static analysis + targeted reading only.

## Verdict

The package is, in effect, clean. After twelve prior fix rounds the invariant surface that
usually harbours bugs in a reducer/persistence layer of this size is closed:

- Prototype-hazard keys (`__proto__`/`constructor`/`prototype`) are screened at all three
  trust boundaries (wire `isSafeId`/`hasUnsafeOwnKeys`, reducer `isSafePatchKey` + every
  table lookup uses `Object.hasOwn`, load boundary `isSafeKey`). I traced every `record[key]=…`
  and `{...r,[k]:…}` write in `applyMutation.ts`; each is gated either by an upstream
  `Object.hasOwn(state.widgets|pages, …)` existence check (so the key is provably a real,
  already-safe id) or by an explicit `isSafePatchKey` guard.
- The reference-equality no-op contract is honored on every handler and every shared
  primitive (`removeWidgetIds`/`removeSpanEntries`/`enforceLayoutColSpans`/`dropWidgetScopedFilters`
  all return their input reference on a no-op), so undo-stack churn cannot leak in.
- Migration version handling is fail-closed at every branch (`NaN`/fractional/non-integer/
  newer-than-current/registry-gap/non-cloneable-input/missing-required-field, incl. per-entry
  nested shape checks). The `structuredClone` try/catch and the `Number.isInteger` gate are
  correct.
- The three partial-payload shapes of `applyBulkUpdate` (both layout fields absent / rows
  present spans absent / spans present rows absent) each avoid the blank-page landmine; the
  spans merge-vs-replace decision keys on the same `rowsProvided` predicate as row placement,
  so a junk `widgetRows: null` cannot flip it to destructive replace.

The following looked suspicious and were **verified sound**, so they are recorded here to
avoid re-flagging:

- **`applyBulkUpdate` removal without a paired layout update is a partial no-op, not a bug.**
  `removeWidgetIds` refuses to delete a `removedWidgetId` still referenced on any surviving
  page's rows. If a (parser-bypassing) payload removes a widget but omits `widgetRows`, the
  widget stays referenced on the active page and is therefore preserved. This maintains the
  rows↔widgets invariant (no phantom row) and the real producer always ships rows+removal
  together, so the degradation is safe.
- **`deserializeState`'s operator-membership filter screen does not drop legitimate filters.**
  The client defaults `operator: 'equals'` for every filter it creates (incl. `rank`/`selection`
  mode), and every operator used anywhere in the client (`equals`/`between`/`greater_than_or_equal`/…)
  is a member of `STUDIO_FILTER_OPERATORS`. No live path produces a persisted filter with an
  out-of-list operator, so the T2-3 screen has no false-drop reachable via the public API.
- **`serializeDoc` empties-to-`undefined` + `deserializeState` re-defaulting** round-trips
  symmetrically; `normalizePersistedPages` and the widget normalizer are genuinely
  reference-stable for well-formed docs (the `changed`/`Array.isArray`-with-non-empty-guard
  logic avoids churn).
- **`normalizeChartSeries` nullish-alias omission**, **`clampSpan` NaN guard**,
  **`toUtcYMD` offset-detection fast path**, **`detectAnomaliesIQR` quartile split** — all
  correct as documented.

---

## Tier 3

### T3-1 — Load-boundary filter-scope validation is shallower than the wire boundary (residual load↔wire asymmetry)

**Where:** `statePersistence.ts:764-806` (`deserializeState`'s `filters` screen) and
`statePersistence.ts:313-321` (`findMissingRequiredField`), versus
`parseStateMutation.ts:272-287` (`validateFilterScope`).

**What:** The wire boundary validates a filter scope's **required id fields** — `validateFilterScope`
walks `FILTER_SCOPE_REQUIRED_IDS[kind]` and rejects a scope missing `widgetId`
(`widget`), `sourceWidgetId`+`pageId` (`cross-filter`/`interactive`), or `sourceId`+`pageId`
(`dashboard-date-range`). The **persistence path does not**: `deserializeState`'s screen only
checks `VALID_FILTER_SCOPE_KINDS.has(scope.kind)` plus `field`/`operator`, and
`findMissingRequiredField` only checks that `scope.kind` is a string. So a hand-edited /
foreign persisted doc carrying e.g. `{ scope: { kind: 'dashboard-date-range' }, field: 'date',
operator: 'between', … }` (no `sourceId`/`pageId`) loads verbatim while the byte-identical
`addFilter` wire payload is rejected.

**Why it matters (and why it's Tier 3, not Tier 2):** This is the same _class_ of gap the
T2-3 work explicitly set out to close (make the load boundary symmetric with the wire boundary
for filter fields the evaluator branches on), so by the package's own precedent it is arguably
Tier 2. It is downgraded because the concrete impact is bounded:

- It is **not crashing** — `dropWidgetScopedFilters`/`removePage`/`serializeDoc` all tolerate a
  missing scope id (`'pageId' in f.scope` is false, `f.scope.widgetId` is `undefined`, etc.).
- For the common `widget` scope a missing `widgetId` is **inert** (no widget has id `undefined`,
  so the filter matches nothing and is silently ignored).
- Only a malformed `dashboard-date-range` scope (missing `sourceId`) could _mis-apply_ a date
  window, and only via a hand-edited doc — the AI/wire path is fully protected.

**Fix direction:** Factor the wire boundary's `FILTER_SCOPE_REQUIRED_IDS` presence loop into a
small shared `isValidFilterScope(scope)` predicate (it already lives one import away) and call it
from both `deserializeState`'s filter screen and `findMissingRequiredField`, replacing the bare
`VALID_FILTER_SCOPE_KINDS.has(kind)` / `typeof scope.kind === 'string'` checks. That closes the
last load↔wire filter asymmetry with no new logic.

### T3-2 — "`deserializeState` is total over nested-corrupt docs" slightly overstates its defensiveness (missing top-level containers throw)

**Where:** `statePersistence.ts:583` (`Object.entries(serialized.widgets)`),
`:703` (`normalizePersistedPages(serialized.pages, …)` → `Object.entries(pages)`),
`:712` (`const { dashboard } = serialized; … dashboard.activePageId`),
`:764` (`serialized.filters.filter(…)`). Doc claim: `deserializeState`'s comments and
`ARCHITECTURE.md` describe it as a "public, directly-callable _total over nested-corrupt docs_
surface."

**What:** `deserializeState` is defensive against _nested_ corruption (a `null` widget/page
value, a `config: null`, a non-array `widgetRows`, a `null` filter/thread entry) but assumes the
four **top-level** containers are present. A direct call with an absent `dashboard`, `pages`,
`widgets`, or `filters` throws (`Cannot read properties of undefined` / `Object.entries(undefined)`)
rather than degrading.

**Why it matters:** Purely a precision/robustness nit. The documented flow is
`migrateState` (whose `findMissingRequiredField` rejects a missing top-level container by name)
→ `deserializeState`, and the `SerializedStudioState` type marks all four required, so a TS
caller cannot reach the throw without both bypassing `migrateState` and casting. It is therefore
unreachable via documented usage — but the "total" phrasing invites a caller to hand it an
arbitrary object, which is exactly the case it is _not_ total over.

**Fix direction:** Either (a) tighten the wording to "total over nested corruption _of an
otherwise top-level-well-formed_ `SerializedStudioState`", or (b) make it genuinely total by
running the same `findMissingRequiredField` top-level gate at the head of `deserializeState`
(returning/throwing a named error, or coercing missing containers to their empty defaults the way
`relationships`/`expressionFields` already are). (a) is the lower-risk change and matches the
real contract.

---

## Areas confirmed with no finding

- `applyMutation.ts` dispatch, all 14 handlers, and the shared removal/layout primitives —
  prototype safety, no-op contract, cross-page guards, span clamp/rebalance, `dedupeLayoutRows`,
  `coerceWidgetConfig`/`isPlainRecord`/`normalizeConfigChartSeries` (all three UPDATE channels
  - both ADD sites).
- `parseStateMutation.ts` — every validator, `isSafeId`/`hasUnsafeOwnKeys`,
  `hasInvalidChartTypeInConfig` on all three patch channels, `validateWidget`'s kind+chart-family
  checks with the `'bar'` fallback, exhaustive `MUTATION_ARG_VALIDATORS` mapped type.
- `configKeyValidation.ts` — `AssertKeysCovered` compile-locks, `Object.hasOwn` guards,
  `stripForeignFamilyKeys`, the derived `CHART_CONFIG_KEYS` union.
- `factories.ts` — `makeIdFactory` collision resistance, `createDefaultStudioState`
  per-partition merge + `activePageId` reconciliation, `BUILTIN_WIDGET_DEFAULTS` `Object.hasOwn`.
- `statePersistence.ts` `migrateState` fail-closed matrix and `findMissingRequiredField`
  nested checks; `serializeDoc`/`serializeState`; `normalizePersistedPages`.
- `widgetTypeGuards.ts`, `unsafeKeys.ts`, `temporalUtils.ts`, `anomalyDetection.ts`,
  `aiToolRegistry.ts`, `mutationTypes.ts`, `stateTypes.ts`, `baseTypes.ts`, `chatTypes.ts`,
  `index.ts` export surface.
