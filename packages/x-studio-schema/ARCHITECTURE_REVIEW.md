# x-studio-schema — Architecture Review (iteration 6)

Fresh, from-scratch review of `packages/x-studio-schema/src` (every file read in full,
cross-referenced against `ARCHITECTURE.md` and all seven test suites). Every finding
below was **empirically reproduced** against the current source (via a throwaway vitest
run in this package), not inferred.

Scope note: iteration 5 hardened the load boundary for `pages`/`widgets` (own-key
screening, nested-corrupt tolerance, `schemaVersion` fail-closed, cross-filter strip
symmetry). Those fixes are all present and correct. The findings below are the
_remaining_ gaps in the same classes — chiefly, the hardening applied to `pages[*]`
and `widgets[*]` was not extended to the doc's other collections (`filters[*]`, `ai`,
`dashboard.activePageId`), and one reducer defense-in-depth guard from iteration 3
(T3.3) covers only one of its two sibling branches.

---

## Tier 1 — must fix

### 1.1 `filters[*]` entries are never shape-checked at the load boundary; a corrupt entry loads successfully, then crashes every subsequent save, undo snapshot, and widget-removal

**Files:**

- `src/statePersistence.ts:181-211` — `findMissingRequiredField` checks `pages[*]`
  (record + array `widgetRows`) and `widgets[*]` (record + record `config`) one level
  down, but for `filters` checks only `Array.isArray(state.filters)` — never the
  entries.
- `src/statePersistence.ts:501-503` — `deserializeState` filters with **tolerant**
  optional chaining (`f?.scope?.kind !== 'cross-filter' && …`), so a `null`,
  primitive, or scope-less entry is _kept_ and installed into live `doc.filters`.
- `src/statePersistence.ts:396-398` — `serializeDoc` then reads `f.scope.kind` with
  **no** optional chaining.
- `src/applyMutation.ts:206-211` (`dropWidgetScopedFilters`), `:1092` (`addFilter`'s
  `f.id` idempotency scan), `:1034-1037` (`removePage`'s scope read) — the reducer
  reads `f.scope.kind` / `f.id` on every entry with no tolerance.

**Repro (confirmed):** persisted doc `{ schemaVersion: 1, …, filters: [null] }`:

1. `migrateState(...)` → `success: true` (filters is an array — passes).
2. `deserializeState(...)` → `doc.filters === [null]` (`null?.scope?.kind` is
   `undefined`, which ≠ `'cross-filter'`, so the entry is kept).
3. `serializeDoc(state.doc)` → **`TypeError: Cannot read properties of null (reading
'scope')`**. `serializeDoc` is the autosave path AND `StudioController`'s undo/redo
   snapshot path, so after loading such a doc, _every doc commit and every save throws_
   — repeated data loss, strictly worse than being rejected at load.
4. `applyDocMutation(doc, removeWidget …)` → same `TypeError` inside
   `dropWidgetScopedFilters`. `addFilter` throws on `f.id`.

Variants: a filter entry with `scope: null` or a primitive entry (`"junk"`) crash the
same way; an entry whose `scope` is a truthy non-record (e.g. `scope: "page"`) does not
crash but installs an unevaluable filter.

**Why Tier 1:** this violates two documented invariants at once — `migrateState`'s
"a nested-corrupt doc is rejected here with a _named field_ rather than crashing later"
contract (statePersistence.ts:176-179) and the load boundary's "TOTAL over a
corrupted/hand-edited doc" claim — and the failure is _deferred_ (load succeeds, then
the persistence loop is bricked). It is exactly the class iteration 5 fixed for
`pages`/`widgets`, left unfixed for `filters`.

**Fix direction:** two symmetric moves, matching the pages/widgets treatment:

1. Extend `findMissingRequiredField` with a per-entry pass: each `filters[i]` must be
   a record with a record `scope` whose `kind` is a string (name the field, e.g.
   `filters[0].scope`).
2. Make `deserializeState`'s filter pass _drop_ any entry that is not a record with a
   record `scope` (in addition to the existing cross-filter/interactive strip), so a
   direct `deserializeState` call (its documented "total over nested-corrupt docs"
   surface) is safe even without `migrateState`.
3. Add regression tests in `statePersistence.test.ts` (a `filters: [null]` fixture
   through both `migrateState` and `deserializeState`, plus a `scope: null` variant).

---

## Tier 2 — should fix

### 2.1 A dangling `dashboard.activePageId` survives the load boundary un-reconciled — blank canvas plus silently no-op'd legacy mutations

**Files:**

- `src/statePersistence.ts:484` — `deserializeState` installs `serialized.dashboard`
  verbatim; nothing checks `activePageId` names a key of the (post-sweep) `pages`.
- `src/statePersistence.ts:181-211` — `findMissingRequiredField` checks `dashboard`
  is a record but not that `activePageId` (or `id`/`title`) is a string, let alone
  resolvable.
- Contrast: `src/factories.ts:274-279` (`createDefaultStudioState`) explicitly
  reconciles a dangling `activePageId` to the first page id, and
  `src/applyMutation.ts:1050-1054` (`removePage`) applies the same fallback — the
  invariant "the active page exists" is enforced everywhere _except_ the load boundary.

**Repro (confirmed):** `deserializeState({ …, dashboard: { …, activePageId: 'nope' },
pages: { p1: … } }, {})` → `doc.dashboard.activePageId === 'nope'` while
`pages` = `{ p1 }`. This also arises _without_ hand-editing `activePageId` itself:
`normalizePersistedPages` legitimately **drops** a page whose value is corrupt (`null`
page, `"__proto__"` key — the iter-5 hardening), and nothing re-points `activePageId`
afterwards. Consequences: the canvas renders no page until the user manually switches;
every legacy mutation that falls back to the active page (`addWidget`,
`setWidgetLayout`, `setWidgetColSpan` without `pageId`, `applyBulkUpdate` with the
stale id) is a silent no-op.

**Fix direction:** after the `normalizePersistedPages` sweep in `deserializeState`,
apply the same reconciliation the factory uses:
`if (!Object.hasOwn(pages, dashboard.activePageId)) activePageId = Object.keys(pages)[0] ?? ''`.
Optionally also have `findMissingRequiredField` require `dashboard.activePageId` to be
a string. Add a regression test (corrupt page dropped by the sweep → `activePageId`
re-pointed).

### 2.2 `doc.ai` is installed verbatim at load; a corrupt `ai.threads` crashes the `renameAIThread` reducer

**Files:**

- `src/statePersistence.ts:507` — `ai: serialized.ai` with no shape check;
  `findMissingRequiredField` never looks at `ai`.
- `src/applyMutation.ts:1329` — `(state.ai.threads ?? []).map(…)`: `??` only guards
  nullish; a non-array truthy value (`threads: "junk"`, `threads: {}`) throws.

**Repro (confirmed):** doc with `ai: { threads: 'junk', activeThreadId: 't1' }` loads
fine; `applyDocMutation(doc, { type: 'renameAIThread', args: { …, threadId: 't1' } })`
→ **`TypeError: (state.ai.threads ?? []).map is not a function`**. (`serializeDoc`
happens to tolerate it — `'junk'.length > 0` — and re-persists the junk verbatim, so
the corruption round-trips indefinitely. The client chat panel, outside this package,
iterates the same field.)

**Fix direction:** in `deserializeState`, keep `ai` only when it is a record with an
array `threads` (drop or default to `undefined` otherwise) — one line, symmetric with
the widgets/pages screening; or add `ai` (when present) to `findMissingRequiredField`.
Add a fixture test.

---

## Tier 3 — nice to have

### 3.1 Reducer defense-in-depth asymmetry: `updateWidget.args.config: null` and `addWidget`/`addedWidgets` with a nullish `config` throw, while the sibling `changes.config: null` is explicitly guarded

**Files:** `src/applyMutation.ts:601-607` (`config !== undefined` admits `null`, then
`normalizeConfigChartSeries(null)` at `:181` throws on the `.ySeries` read),
`:564` (`addWidget` → `normalizeConfigChartSeries(widget.config)`), `:1237`
(`applyBulkUpdate.addedWidgets`, same call; note `updatedWidgets[].config` at `:1271`
IS truthiness-guarded). Contrast `:668-675`: the `changes.config` branch carries an
explicit `value && typeof value === 'object'` guard whose comment names exactly this
threat model ("a server-built mutation with `changes: { config: null }` …").

**Repro (confirmed):** `applyDocMutation(doc, { type: 'updateWidget', args: {
widgetId: 'w1', config: null } })` → `TypeError: Cannot read properties of null
(reading 'ySeries')`; the `changes: { config: null }` twin is a clean no-op. Same
throw for `addWidget` with `config: null`.

The wire boundary (`parseStateMutation`) rejects all of these, so this is unreachable
via SSE — but the file's own documented rationale for its guards is precisely the
"server builds mutations from LLM tool arguments _without_ the parser" path
(`executeToolOnState`), where a mid-turn reducer throw aborts the agentic loop. T3.3
fixed one of the two branches; finish the pair: treat a non-record `config` as absent
in `updateWidget`, and skip `normalizeConfigChartSeries` (or the whole insert) for a
non-record `widget.config` in `addWidget`/`addedWidgets`. Add the two missing reducer
tests.

### 3.2 Minor guard-convention inconsistencies in the reducer (no pollution risk, but drift from the file's own convention)

- `addWidget` (`src/applyMutation.ts:571`) and `addPage` (`:513`) insert via object
  literals (`{ ...state.widgets, [widget.id]: … }`) with **no** `isSafePatchKey` check
  on the id, while `applyBulkUpdate.addedWidgets` (`:1223`) checks it before an
  equivalent insert. Literal computed keys use define-semantics, so there is _no_
  prototype pollution — but a server-built `addWidget`/`addPage` with id `'__proto__'`
  creates a real own-`__proto__` entry that persists, then silently _vanishes on the
  next load_ (the iter-5 key screen drops it): transient data loss and an
  inconsistency with the sibling handler. One `isSafePatchKey` early-return each
  restores uniformity.
- `applyBulkUpdate` (`:1119`, `:1157`, `:1170`) null-tolerates `removedWidgetIds ??
[]` / `addedWidgets ?? []` / `updatedWidgets ?? []` but reads `widgetRows.map(…)`
  and `Object.keys(widgetColSpans)` unguarded — a partial server-built payload throws
  only when the target page exists. Same `?? []` / `?? {}` treatment would make the
  tolerance uniform.

### 3.3 `relationships` / `expressionFields` / `filterPresets` container types are unvalidated at the load boundary

`src/statePersistence.ts:504-506` uses `?? []`, which only defaults _absent_ values —
`relationships: "junk"` or `{}` is installed verbatim (`findMissingRequiredField`
doesn't check them since they're optional). Nothing in this package crashes (the
reducer never touches them), but client code iterating `doc.relationships` will, and
`serializeDoc`'s `.length > 0` re-persists junk (a non-array with no `length` even
collapses to `undefined`, silently discarding whatever it was). Cheap fix:
`Array.isArray(x) ? x : []` for the three collections.

### 3.4 Documentation accuracy: `applyBulkUpdate`'s "concurrently created widgets are preserved" claim is true for the widget _record_, not its _placement_

`ARCHITECTURE.md` (§`mutationTypes.ts` and §`applyBulkUpdate`) says a widget
concurrently created while the turn ran "is preserved rather than silently reverted."
Verified against `src/applyMutation.ts:1146-1158`: the widget's `widgets` entry indeed
survives, but the active page's `widgetRows` are _replaced_ by the producer's rows
(computed from the turn-start snapshot), so a widget the user added to the active page
mid-turn is dropped from the layout and becomes an unplaced, invisible-but-recoverable
widget. That is the correct trade-off for a layout replacement, but the doc should say
"the widget record is preserved (it may be un-placed from the active page's layout)"
rather than implying full preservation.

### 3.5 Missing test coverage (for the load-bearing paths above)

- No `statePersistence.test.ts` fixture for a corrupt `filters` entry (1.1), a corrupt
  `ai` (2.2), or a dangling/sweep-orphaned `activePageId` (2.1) — the existing
  corrupt-doc suite covers `pages`/`widgets` only.
- No `applyMutation.test.ts` case for top-level `updateWidget.args.config: null` or a
  nullish `addWidget` config (3.1) — only the `changes.config: null` twin is pinned
  (T3.3 tests).

---

## Verified sound (checked, no action)

For completeness, load-bearing areas that were explicitly re-verified against current
source and found correct: reducer purity and the reference-equality no-op contract in
all 14 handlers (including the merge-shaped `updateWidget`/`applyBulkUpdate` value
comparisons via `shallowRecordEqual`/`rowsEqual`/`spansEqual`); `Object.hasOwn`
discipline on every prototype-chain-sensitive lookup; the `isSafeKey` triad at all
three trust boundaries for `pages`/`widgets`/span keys; `dedupeLayoutRows` /
`enforceLayoutColSpans` invariants (including the 2→1 collapse scoping and overflow
sum); `setWidgetColSpan`'s current-row derivation, wrong-page orphan guard, and
fallback-path sibling checks; `migrateState`'s integer/NaN/fraction/negative/newer
version handling, registry-gap hard failure, clone-failure catch, and
`structuredClone` isolation; `serializeDoc`/`deserializeState` cross-filter +
interactive symmetry and empties-are-omitted normalization; `normalizeChartSeries`
totality over junk entries and nullish-alias handling; `parseStateMutation`'s
exhaustive validator table (spot-checked field-by-field against the reducer's actual
key/iteration usage, including `rowWidgetIds` per-entry ids and `changes` field
types); `truncateToPeriod`/`isoWeek` fast-path/fallback split and week-year boundary;
`detectAnomaliesIQR` guards; the three compile-time exhaustiveness locks
(`AssertKeysCovered`, `AssertChartTypesCovered`, `AssertAllChartTypesListed`) and the
runtime table-sync pins; the `aiToolRegistry` facts table (the five MCP-only "extra"
tools are deliberately outside it, documented in
`x-studio-ai-middleware`'s `mcp/toolMetadata.ts`); `index.ts` export surface (no
duplicate bindings, `normalizePersistedPages` intentionally internal).
