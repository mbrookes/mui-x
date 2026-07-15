# Architecture Review — @mui/x-studio-schema (Iteration 12)

Summary: 0 Tier 1, 3 Tier 2, 2 Tier 3.

Fresh, clean-slate review of every runtime and type module under
`packages/x-studio-schema/src/`, cross-referenced against `ARCHITECTURE.md`. All
findings were derived from the current source (not carried over from prior rounds),
and each includes a sibling-site sweep across the package.

## Verified sound (do not re-investigate)

- **Prototype-pollution surface.** Every bracket write in the package was enumerated.
  All writes with an untrusted key are guarded (`isSafePatchKey` /
  `Object.hasOwn`-gated / literal define-semantics / `Object.fromEntries` rebuilds /
  delete-only), and every unguarded write's key is transitively safe (only reachable
  after an `Object.hasOwn(state.widgets|pages, id)` gate, and unsafe ids can never be
  installed into those records in the first place — `addPage`/`addWidget`/
  `applyBulkUpdate.addedWidgets` screen ids, and the load boundary drops unsafe
  `pages`/`widgets` keys). No reachable pollution path exists through
  `applyMutation`, `parseStateMutation`, or `deserializeState`.
- **Reducer dispatch and table sync.** `MUTATION_HANDLERS` /
  `MUTATION_ARG_VALIDATORS` are both mapped-type exhaustive over `StateMutation`;
  both dispatchers use `Object.hasOwn` before the bracket read (prototype-member
  `type` is a graceful no-op). `MUTATION_TYPES`/`PARSEABLE_MUTATION_TYPES` are
  exported for the runtime sync pin.
- **Reference-equality no-op contract.** Every handler was traced; all honor it,
  including the merge-shaped ones (`updateWidget.changes`,
  `applyBulkUpdate.updatedWidgets`) via `shallowRecordEqual`/`spansEqual`/`rowsEqual`.
  `normalizePersistedPages` and the `deserializeState` widget normalization are
  reference-stable for well-formed docs (pinned by tests).
- **`migrateState`.** Fail-closed version derivation (`NaN`/fractional rejected),
  registry-gap hard failure, `structuredClone` try/catch, and per-entry
  `findMissingRequiredField` nesting checks all hold as documented.
- **Layout totality (T1-1 / finding 2.5 lineage).** All three
  `applyBulkUpdate` partial-payload shapes behave as documented for ROW placement
  (both absent → skip; rows present → install; spans-only → reconcile against
  existing rows). The residual gap found this round is on the spans merge-vs-replace
  decision, not row placement — see Finding 2.
- **`updateWidget` ordering,** `unsetFields` runtime denylist, `changes.id`
  rejection, `isPlainRecord` uniformity across all config channels, and
  `coerceWidgetConfig` at both add sites: all correct.
- **Factories, `widgetTypeGuards`, `configKeyValidation`, `temporalUtils`,
  `anomalyDetection`, `unsafeKeys`, `aiToolRegistry`:** no reachable defects. The
  compile-time completeness locks (`AssertKeysCovered`, `AssertAllChartTypesListed`,
  `AssertAllFilterOperatorsListed`, `AssertChartTypesCovered`) are all present and
  correctly shaped. `getAllowedChartConfigKeys` fail-closes on prototype-member
  chart types via `Object.hasOwn` as documented. `detectAnomaliesIQR` and
  `truncateToPeriod`/`isoWeek` are total over junk input.
- **`index.ts` export surface** matches consumer imports (all 39 cross-package
  import sites resolve; no consumer deep-imports an unexported symbol). One doc
  divergence about `unsafeKeys.ts` — see Finding 5.

---

## Finding 1 (Tier 2) — Load boundary does not enforce the row-overflow col-span invariant

**Where:** `packages/x-studio-schema/src/applyMutation.ts:411-421`
(`normalizePersistedPages`'s span rebuild loop).

**Invariant violated:** `StudioPage.widgetColSpans`'s documented contract
(`widgetTypes.ts:1086-1092`: "a row whose spans sum above `GRID_COLS` is rebalanced
or dropped") and `enforceLayoutColSpans`'s own doc
(`applyMutation.ts:286-289`: "the SOLE implementation of the col-span invariants:
every layout path … reaches them through here"). The load-boundary sweep is a layout
path that does NOT reach them: it clamps each span into `MIN_SPAN`–`GRID_COLS`,
drops unsafe keys and orphans, and dedupes rows — but never checks a row's span SUM.

**Reachable failure:** a hand-edited/foreign persisted doc with
`widgetRows: [['w1','w2']]`, `widgetColSpans: { w1: 20, w2: 20 }` passes
`deserializeState` completely untouched (both spans are individually in range, safe,
and non-orphaned, so the value-equality check at `applyMutation.ts:429-436` carries
the page through by reference). The canvas then renders a 40/24 row — overflowing
widths — until some later layout mutation on that page happens to run
`enforceLayoutColSpans`. Clamping can even _create_ this state: a persisted
`{ w1: 40, w2: 6 }` on a shared row is "fixed" to `{ w1: 24, w2: 6 }` (sum 30 > 24)
and installed. The existing clamp test (`statePersistence.test.ts:703-720`) only
uses single-widget rows, so the gap is untested.

**Sibling-site sweep:** every LIVE layout path enforces overflow —
`setWidgetLayout` (`applyMutation.ts:942-946`, via `enforceLayoutColSpans`),
`applyBulkUpdate` (`applyMutation.ts:1336`, via `enforceLayoutColSpans` with
`oldRows = []`), `setWidgetColSpan` (its own rebalance branch,
`applyMutation.ts:1036-1056`). `removeWidget` needs no overflow check (removal can
only shrink a sum) and correctly handles the 2→1 collapse. The load boundary
(`normalizePersistedPages`) is the only layout-installing site missing it.

**Fix direction:** after the clamp loop, run the rebuilt spans through
`enforceLayoutColSpans([], sanitizedRows, rebuilt)` — exactly the
`applyBulkUpdate` pattern (`oldRows = []` so a pre-existing singleton span is never
collapsed, while row-overflow drop, orphan drop, and empty→`undefined` collapse all
apply). Reference stability is preserved automatically by the existing
`spansEqual` comparison. Add a shared-row overflow fixture to
`statePersistence.test.ts`.

## Finding 2 (Tier 2) — `applyBulkUpdate`: junk `widgetRows` flips the spans decision from MERGE to REPLACE

**Where:** `packages/x-studio-schema/src/applyMutation.ts:1332-1335` (the
`spansToEnforce` ternary), inconsistent with `applyMutation.ts:1283`
(`Array.isArray(widgetRows)`).

**Invariant violated:** the T2-2 residual-lost-update rule documented at
`applyMutation.ts:1319-1331`: a bulk that did not re-place rows must MERGE its span
entries onto the page's existing spans ("wholesale-replacing the receiver's map …
silently reverts a concurrent client drag-resize of a DIFFERENT widget"). The rows
decision treats a present-but-non-array `widgetRows` (e.g. `null` from a hand-built,
parser-bypassing payload — the same established `executeToolOnState`-class channel
the surrounding guards exist for) as ABSENT (`applyMutation.ts:1282-1287`, rows
preserved), but the merge-vs-replace decision two steps later keys on
`widgetRows === undefined`, so `null` takes the REPLACE branch. The handler's own
rationale ("when `widgetRows` IS present the producer genuinely re-placed rows …
so the wire spans must replace") is contradicted: rows were NOT re-placed, yet the
spans replace.

**Reachable failure:** page has `widgetRows: [['w1'],['w2']]`,
`widgetColSpans: { w1: 12, w2: 18 }`. A hand-built
`applyBulkUpdate { widgetRows: null, widgetColSpans: { w1: 8 }, activePageId }`
applies: rows preserved (correct), but the span map becomes `{ w1: 8 }` — w2's
concurrent/unnamed span (18) is silently wiped. That is precisely the lost-update
class the T2-2 merge fix closed for the `widgetRows === undefined` shape. The
existing regression test (`applyMutation.test.ts:2440-2472`, "present-but-non-array
widgetRows (null) as ABSENT") does not catch it because its fixture carries only one
span entry, for which merge ≡ replace.

**Sibling-site sweep:** three decision points read `widgetRows`'s presence in this
handler and use THREE different predicates: `widgetRows !== undefined`
(`hasLayoutUpdate`, line 1228 — fine, junk should still enter the layout block),
`Array.isArray(widgetRows)` (rows resolution, line 1283 — correct), and
`widgetRows === undefined` (spans merge, line 1333 — the defective one). No other
handler shares this pattern (`setWidgetLayout` has a single required `rows`).

**Fix direction:** derive one predicate — `const rowsProvided =
Array.isArray(widgetRows)` — and use it for both the rows resolution and the
merge-vs-replace decision (`spansToEnforce = rowsProvided ? clampedSpans :
{ ...(page.widgetColSpans ?? {}), ...clampedSpans }`). Extend the junk-`widgetRows`
regression test with a second, unnamed span entry that must survive.

## Finding 3 (Tier 2) — Load-boundary filter screening skips `filterPresets[*].filters` (fail-open operator reachable via apply-preset) and omits the `field` check

**Where:** `packages/x-studio-schema/src/statePersistence.ts:211-232`
(`screenFilterPresets` — `isRecord` per entry only) and
`statePersistence.ts:735-769` (the `doc.filters` load screen).

**Invariant violated:** the load-boundary symmetry rule the `doc.filters` screen
itself documents (`statePersistence.ts:756-767`): a persisted filter's `operator`
(and present `operator2`) must be membership-checked against the closed
`StudioFilterOperator` union because the client evaluator FAILS OPEN on an unknown
operator (`filterUtils.ts` `default: return () => true`) — "a chip that renders as
ACTIVE while filtering nothing." That screen is applied to `doc.filters` only.
Preset-embedded filters are screened for record-ness alone, yet they are
rematerialized VERBATIM (minus `id`/`scope`) into live `doc.filters` by
`@mui/x-studio`'s `docTransforms.applyFilterPreset`
(`packages/x-studio/src/store/docTransforms.ts:357-386` — `{ ...f, id: fresh,
scope: page }`), which performs no operator/field validation of its own.

**Reachable failure (a):** a hand-edited/shared doc carries
`filterPresets: [{ id, name, filters: [{ id, field: 'region', operator: 'equal',
value: 'EU', scope: {...} }] }]` (a plausible typo for `'equals'`). It loads
cleanly — `screenFilterPresets` only requires records — and the moment the user
clicks "apply preset", the junk-operator filter lands in `doc.filters` as an
active, fail-open chip: displayed data silently unfiltered while the UI claims a
filter is applied. This is exactly the failure mode the prior-round operator screen
was added to prevent, one indirection away. (Scope junk in presets is harmless —
`applyFilterPreset` re-stamps `scope` — but `operator`/`operator2`/`field` travel
verbatim.)

**Reachable failure (b):** the `doc.filters` screen itself omits the
`field`-must-be-a-string check that the wire boundary applies and justifies at
`parseStateMutation.ts:331-333` ("a junk value like `field: 42` … would install an
active-but-unevaluable filter that silently renders every widget in scope empty").
A hand-edited `field: 42` in persisted `filters` loads today and produces that
exact state; the wire boundary rejects the identical payload.

**Sibling-site sweep:** filter-shaped entries cross a trust boundary at four sites:
(1) wire `addFilter` — full checks (`isSafeId` id, `isString` field, operator +
operator2 membership, scope validation) at `parseStateMutation.ts:324-341`;
(2) load `doc.filters` — record + scope-kind membership + session-scope strip +
operator/operator2 membership, but NO field check (`statePersistence.ts:735-769`);
(3) load `filterPresets[*].filters` — record-ness only
(`statePersistence.ts:211-232`); (4) `migrateState`'s
`findMissingRequiredField` — shape-only by design (record + record scope with
string kind for `filters`; record-only for preset entries), which is fine since it
is the loud reject layer, not the semantic screen. Sites (2) and (3) are the gaps.

**Fix direction:** in `screenFilterPresets`, screen each inner filter with the same
predicate set the `doc.filters` pass uses for the verbatim-travelling fields —
drop entries whose `field` is not a string or whose `operator`/present `operator2`
fails `isStudioFilterOperator` (scope checks stay unnecessary there because
`applyFilterPreset` re-stamps scope). Add the `isString(f.field)` check to the
`doc.filters` screen for symmetry with `parseStateMutation`. Both changes are
drop-the-entry (the established gentle load-boundary treatment), reference-stable
when nothing is dropped.

## Finding 4 (Tier 3) — ARCHITECTURE.md misdocuments the junk-`widgetRows` coercion (says "coerced to `[]`", code preserves existing rows)

**Where:** `packages/x-studio-schema/ARCHITECTURE.md:197` (the `applyBulkUpdate`
bullet's closing sentence: "a `widgetRows` present-but-non-array (or a non-array row
within it) is coerced to `[]`/dropped") vs.
`packages/x-studio-schema/src/applyMutation.ts:1275-1287` and the regression test
`applyMutation.test.ts:2440-2472`.

**Divergence:** the code deliberately treats a present-but-non-array `widgetRows` as
ABSENT (reconciling against the page's EXISTING rows — the code comment explicitly
brands the `[]` coercion "DESTRUCTIVE" and rejects it), and the test pins rows being
preserved. The doc still describes the pre-fix behavior. The same paragraph also
never mentions the T2-2 spans-MERGE semantics for the rows-absent shape (shape 3 is
described as "changes only widths" without stating that unnamed existing spans
survive via merge) — worth folding into the same doc touch-up. No runtime impact;
doc-accuracy only. (Note for the fix round: Finding 2 changes this exact behavior's
spans half, so update this doc sentence once, after that fix.)

**Sibling sweep:** no other ARCHITECTURE.md claim about `applyBulkUpdate`'s layout
shapes diverges from the code; shapes (1) and (2) and the T1-1 shape-(3) rows
behavior are described accurately.

## Finding 5 (Tier 3) — ARCHITECTURE.md claims `index.ts` re-exports every function module by name; `unsafeKeys.ts` is not exported at all

**Where:** `packages/x-studio-schema/ARCHITECTURE.md:12` ("Function modules
(`factories.ts`, `anomalyDetection.ts`, `unsafeKeys.ts`, `applyMutation.ts`, …) —
… `index.ts` re-exports these **explicitly by name**") vs.
`packages/x-studio-schema/src/index.ts` (no export from `./unsafeKeys`).

**Divergence:** `UNSAFE_KEYS`/`isSafeKey` are package-internal — `index.ts` exports
nothing from `unsafeKeys.ts`, and a grep of both consuming packages confirms no
external import site exists (so nothing is broken at runtime; the doc's stated
"runtime surface visible at a glance from `index.ts`" property is what's violated).
Either export the two names (they are a reasonable shared guard for
`executeToolOnState`-style server-built mutation producers) or correct the doc to
list `unsafeKeys.ts` as the one internal-only function module. `normalizePersistedPages`
(exported from `applyMutation.ts` for `statePersistence.ts`'s internal use, also not
in `index.ts`) is fine as-is — the doc describes it as a load-boundary internal.

**Sibling sweep:** every other function-module export named in ARCHITECTURE.md's
module list was checked against `index.ts` — all present
(`factories`, `anomalyDetection`, `applyMutation` (public trio + constants),
`parseStateMutation`, `widgetTypeGuards`, `configKeyValidation`, `temporalUtils`,
`statePersistence`). Only `unsafeKeys.ts` diverges.

---

## Areas explicitly checked and clean

- No Tier 1 findings this round: no reachable prototype-pollution, injection, or
  data-loss path through `applyMutation`, `parseStateMutation`,
  `serializeDoc`/`deserializeState`, `migrateState`, the factories, or the guards.
- `mutationTypes.ts`/`richContextTypes.ts`/`chatTypes.ts`/`aiTypes.ts`/`dataTypes.ts`/
  `expressionTypes.ts`/`baseTypes.ts`/`stateTypes.ts`/`widgetTypes.ts`: type-only,
  internally consistent, and consistent with the runtime tables that mirror them
  (`OptionalWidgetField` correctly resolves to the four optional widget fields;
  `FILTER_SCOPE_REQUIRED_IDS` matches `StudioFilterScope`; the ten chart-family
  interfaces match `CHART_TYPE_CONFIG_KEYS` under compile locks).
- `aiToolRegistry.ts` is consistent with its `satisfies` contract; MCP-only data
  tools (`compute_field_stats`, `describe_data_source`, …) living outside the
  registry are middleware-side additions, out of this package's documented scope.
