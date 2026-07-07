# Architecture / tech-debt review — `@mui/x-studio-schema`

Independent review of `packages/x-studio-schema/src/` (all 20 files read in full), 2026-07-07.
Line numbers refer to the current working tree. Cross-package claims (grid constants,
`parseStateMutation` call sites, controller delegation, `FieldCapability` copy) were verified
against `packages/x-studio` / `packages/x-studio-ai-middleware` source, not taken from comments
or `ARCHITECTURE.md`.

**Partition sanity-check (asked for explicitly):** the doc/session/runtime split holds up well.
Handlers are typed against `StudioDoc` only (`applyMutation.ts:178-181`), the wrapper provably
leaves `session`/`runtime` referentially identical (`applyMutation.test.ts:1287-1348`), the
cross-filter-lives-in-doc/stripped-at-persistence design is implemented as described
(`statePersistence.ts:241`), and `deserializeState` never resurrects session/runtime data.
No handler assumes the old flat shape. The real problems are elsewhere — below.

---

## Tier 1: Correctness & Security

### 1.1 `updateWidget.unsetFields` can delete the required `title` and `kind` fields — the "cannot void a required field" guarantee does not hold

- `packages/x-studio-schema/src/applyMutation.ts:333-348` (runtime guard), `src/aiTypes.ts:79` (type), `src/parseStateMutation.ts:229-231` (validator)

The reducer goes to great lengths to stop a wire payload from voiding a required field: `changes`
keys with `undefined` values are skipped (`applyMutation.ts:300-310`), and the comment declares
`unsetFields` the "sanctioned" clear affordance. But the runtime guard for `unsetFields` only
excludes `'id'` and `'config'` (`applyMutation.ts:340`), the compile-time type
`(keyof Omit<StudioWidget, 'id'>)[]` _includes_ `'title'` and `'kind'`, and `parseStateMutation`
accepts any `string[]`.

**Failure scenario:** the SSE payload
`{ type: 'updateWidget', args: { widgetId: 'w1', unsetFields: ['kind', 'title'] } }` passes the
validator, and the reducer deletes both keys. The result is a value that no longer satisfies
`StudioWidget` (kind-less widgets can't be dispatched by the widget factory; `title` is read
unguarded across the client). `serializeDoc` then persists the corrupt widget, so the breakage
survives reload — and note the same widget would now _fail_ `validateWidget` if it ever came back
over the wire.

**Fix:** extend the runtime denylist to all required fields (`id`, `config`, `kind`, `title`) and
narrow the `unsetFields` element type to the optional keys of `StudioWidget`.

### 1.2 Prototype poisoning of a widget's `config` object via patch _keys_ — the id-hygiene defense only covers ids, not record keys inside patches

- `packages/x-studio-schema/src/applyMutation.ts:283-291`; validator gap at `src/parseStateMutation.ts:223-226`

`parseStateMutation` rejects `'__proto__'`/`'constructor'`/`'prototype'` as _ids_ (`isSafeId`),
but `updateWidget.args.config` is only checked with `isRecord`. `JSON.parse` creates `__proto__`
as an **own** property, `Object.entries(config)` therefore yields it, and the reducer's patch loop
does a bare bracket assignment:

```ts
const nextConfig = { ...existing.config } as Record<string, unknown>;
for (const [key, value] of Object.entries(config)) {
  ... nextConfig[key] = value;   // key === '__proto__' invokes the inherited setter
}
```

`nextConfig['__proto__'] = value` (with `value` an object) replaces the config object's
`[[Prototype]]` with an attacker-chosen object.

**Failure scenario:** a malformed/hostile SSE event
`{ type: 'updateWidget', args: { widgetId: 'w1', config: { "__proto__": { gridPkField: "id" } } } }`
passes validation and produces a widget whose config _appears_ to contain `gridPkField: "id"` to
every bare `config.x` read in the client (e.g. enabling grid write-back), while
`JSON.stringify`/`serializeDoc` sees only own properties — so the live state and the persisted
state silently disagree. This is exactly the class of bug the file's own header says
`parseStateMutation` exists to close (`parseStateMutation.ts:10-14`); it is closed for
`nextWidgets[widget.id]` but not for patch keys. (The `changes` loop at
`applyMutation.ts:301-305` has the same bracket assignment but is harmless: the poisoned
prototype of the local `definedChanges` is dropped by the subsequent own-property spread.
`applyBulkUpdate`'s config merge uses spread, which defines an own `__proto__` data property —
also safe.)

**Fix:** either reject dangerous keys in the validator for `config`/`changes` records, or make
the patch loop pollution-proof (null-prototype scratch object, or skip
`__proto__`/`constructor`/`prototype` keys — mirroring what `removeSpanEntries` already does for
span records).

### 1.3 Persistence load path is fail-open: `migrateState` "succeeds" on structurally-empty objects, then `deserializeState` throws

- `packages/x-studio-schema/src/statePersistence.ts:139-144` (`validateStateStructure`), `:274` (`Object.entries(serialized.widgets)`)

`validateStateStructure` checks only `typeof state === 'object'`. `migrateState({ schemaVersion: 1 })`
returns `success: true` with the input passed through by reference. The only consumer gate is
`result.success` (`packages/x-studio/src/store/StudioController.ts:1675-1679`), after which
`deserializeState` runs `Object.entries(serialized.widgets)` → `TypeError: Cannot convert
undefined or null to object`, or, for a doc missing `dashboard`, builds a state whose first
reducer touch (`state.dashboard.activePageId`) throws later and further from the cause.

**Failure scenario:** any truncated, hand-edited, or partially-written persisted blob that is
still a JSON object crashes with an unhandled `TypeError` instead of the structured
`MigrationResult` failure the API promises ("Say what happened / why / how to solve" per repo
error guidelines — this path says none of them).

**Fix:** have `migrateState` (or a guard at the top of `deserializeState`) verify the required
top-level fields (`dashboard`, `pages`, `widgets`, `filters`) and return a failed
`MigrationResult` naming the missing field.

### 1.4 A forgotten migration entry silently "succeeds": the version-gap branch stamps `schemaVersion` without transforming

- `packages/x-studio-schema/src/statePersistence.ts:210-216`

The sequential migration loop treats a missing `migrations[version]` entry as "No migration
needed, just bump version". The documented workflow (`:84-91`) is: bump
`CURRENT_SCHEMA_VERSION`, _then_ add the entry. If step 2 is forgotten (or the entry key is
off-by-one), every old persisted doc is stamped with the new version untransformed and reported
as a successful migration — the exact silent-drift failure the framework exists to prevent, and
one that additionally _corrupts_ stored state, because the mis-stamped doc will never be migrated
again. The `StudioDoc['schemaVersion']` literal type (`stateTypes.ts:153`) and the factory's
hardcoded `schemaVersion: 1` (`factories.ts:175`) give some compile-time pressure, but nothing
protects the runtime path, and `deserializeState`'s `as 1` cast (`:271`) suppresses it.

**Fix:** make a missing migration for `version < CURRENT_SCHEMA_VERSION` a hard
`MigrationResult` failure; when a bump genuinely needs no transformation, register an explicit
identity migration (like the existing `0:` entry).

### 1.5 `removePage` deletes widgets still referenced by other pages' rows — inconsistent with `applyBulkUpdate`'s own `stillReferenced` guard

- `packages/x-studio-schema/src/applyMutation.ts:575-581` vs `:689-704`

`applyBulkUpdate` carefully refuses to delete a widget id that still appears in another page's
rows (documented at `:685-688` as protecting against a dangling id / blank card).
`removePage` deletes every widget in `widgetIdsOnPage` unconditionally and also drops all their
filters. Cross-page row references are a real state (nothing prevents `setWidgetLayout` /
`applyBulkUpdate.widgetRows` from naming an id already on another page, and `removeWidget`
explicitly sweeps _all_ pages' rows because of it).

**Failure scenario:** widget `w` appears in both `page-1` and `page-2` rows.
`removePage('page-1')` deletes `w` from `doc.widgets` and drops its widget-scoped filters while
`page-2.widgetRows` still contains `'w'` → permanent blank card plus lost filters on the
surviving page.

**Fix:** apply the same still-referenced check `applyBulkUpdate` uses before deleting widgets
(and their filters) in `removePage`.

### 1.6 `truncateToPeriod` fast path diverges from the `Date` fallback: timezone offsets ignored and impossible dates accepted

- `packages/x-studio-schema/src/temporalUtils.ts:31-37`

The fast path fires for any string with `-` at positions 4 and 7 and slices the _wall-clock_
date part; the fallback (and both prior hand-copies this file replaced, per its own header)
convert to UTC.

**Failure scenarios:**

1. `'2024-01-01T02:00:00+05:00'` → fast path buckets to `2024-01-01`; the same instant as a
   `Date`/epoch-number input buckets to `2023-12-31`. The same dataset produces different
   day/month/week buckets depending on whether the DB driver returns strings or Dates — a silent
   chart-grouping regression relative to the pre-consolidation behavior.
2. `'2024-13-40'` → fast path emits month key `'2024-13'`; the old code (`new Date(...)` →
   Invalid Date) returned `null`. Garbage keys now flow into chart axes.

**Fix:** restrict the fast path to offset-free / `Z` strings and range-check month (1-12) and
day (1-31), falling back to `Date` otherwise.

### 1.7 `addWidget` idempotency guard only inspects the target page's rows

- `packages/x-studio-schema/src/applyMutation.ts:244-248`

The re-delivery guard requires the widget to exist **and** be present in the _target_ page's
rows. If an at-least-once SSE re-delivery arrives after the user has moved the widget to another
page, the guard misses: the handler appends a fresh `[widget.id]` row on the original target page
and overwrites the widget object (reverting user edits). The widget now renders on two pages.
Narrow window, but it is precisely the re-delivery scenario the guard's comment claims to close.
**Fix:** treat existence in `state.widgets` (or any page's rows) as "already applied".

### 1.8 (Lower severity) `applyBulkUpdate` writes `widgetColSpans` verbatim — no clamping, no overflow enforcement, no empty-map normalization

- `packages/x-studio-schema/src/applyMutation.ts:679`; validator at `parseStateMutation.ts:340-342`

`setWidgetColSpan` clamps to `MIN_SPAN..GRID_COLS` and rebalances overflow;
`setWidgetLayout` runs `enforceLayoutColSpans`. `applyBulkUpdate` stores whatever the wire says:
spans of `1`, `-5`, or `240` (validator only requires finite numbers), rows summing far past 24,
and an empty `{}` instead of the `undefined` every other handler collapses to. An AI-produced
bulk update can therefore persist exactly the corrupted layouts the other two handlers exist to
prevent. **Fix:** run each value through `clampSpan` and the row-overflow check (and collapse
empty to `undefined`) before writing.

### 1.9 (Lower severity) `migrateState`'s documented pattern mutates the caller's nested state

- `packages/x-studio-schema/src/statePersistence.ts:88-89` ("Mutating the input is fine — it is already a spread copy") vs `:190` (shallow spread only)

`{ ...state }` copies one level; the recommended migration examples (`:109-117`) mutate nested
filter/widget objects in place — i.e. the caller's objects. `StudioController` passes _retained_
session snapshot objects into `migrateState` (`StudioController.ts:1743`), so the first real
nested-shape migration written to this recipe will silently corrupt stored undo/redo snapshots.
Also, the already-current branch (`:165-173`) returns the input by reference, so
`deserializeState`'s doc aliases the caller's blob. **Fix:** deep-copy (e.g.
`structuredClone`/JSON round-trip) at the top of `migrateState`, or correct the comment to demand
copy-on-write migrations.

---

## Tier 2: Structural Duplication

### 2.1 `FieldCapability` maintained as two hand-synced copies

- `packages/x-studio-schema/src/dataTypes.ts:13` and `packages/x-studio/src/utils/fieldCapabilities.ts:13`

The schema comment itself admits the client "keeps a structurally-identical copy". Both are the
literal union `'numeric' | 'categorical' | 'temporal' | 'rankTarget'`. `StudioDataField.capabilities`
(persist-adjacent, AI-visible) is typed against the schema copy while all client capability logic
uses the local copy — adding a capability to one and not the other type-checks fine on both sides
and silently mis-filters pickers. **Fix:** the client file should re-export the schema type
(same pattern already used for `GRID_COLS` in `canvasGridConstants.ts`).

### 2.2 Two contradictory descriptions of the column-span unit system

- `packages/x-studio-schema/src/widgetTypes.ts:712-717` ("Per-widget explicit column span (3–12)",
  "total columns in a row do not need to sum to 12") vs `src/applyMutation.ts:39-41`
  (`GRID_COLS = 24`, `MIN_SPAN = 6`)

The runtime single-source-of-truth consolidation was done properly (verified:
`canvasGridConstants.ts` re-exports from the schema), but the _type-level_ documentation on
`StudioPage.widgetColSpans` still describes the old 12-column system. This JSDoc is exactly what
a developer — or an LLM given the type — reads when producing span values, and "3–12" values are
silently legal (they pass `clampSpan` after being bumped to 6) so the drift produces
wrong-but-valid layouts rather than errors. **Fix:** rewrite the JSDoc in terms of
`GRID_COLS`/`MIN_SPAN`.

### 2.3 Two different normalization strategies for the two legacy config shapes

- `normalizeGridColumn`: applied once at the persistence boundary (`statePersistence.ts:274-287`)
- `normalizeChartSeries`: never applied at the boundary; each consumer must remember to call it
  (`factories.ts:140` even says "Call this when reading persisted state (same pattern as
  `normalizeGridColumn`)" — but `deserializeState` doesn't)

Verified call sites: `ChartSetupPanel.tsx`, `StudioMixedChart.tsx` call it ad hoc. Any consumer
that reads `ySeries[].type` directly (AI prompt builders, exports, future widgets) silently gets
the wrong `seriesType`/`type` precedence for persisted docs. **Fix:** normalize `ySeries` inside
`deserializeState` next to the columns normalization, then the per-consumer calls become
redundant hardening.

### 2.4 The schema version literal lives in three places

- `statePersistence.ts:9` (`CURRENT_SCHEMA_VERSION = 1`), `stateTypes.ts:153`
  (`schemaVersion: 1` literal type), `factories.ts:175` (`schemaVersion: 1` value)

Bumping the version requires touching all three (the type literal at least forces a compile
error at the factory; nothing ties `CURRENT_SCHEMA_VERSION` to the other two), and
`deserializeState`'s `serialized.schemaVersion as 1` cast (`statePersistence.ts:271`) erases the
one place a mismatch would surface. Combined with finding 1.4 this is how a version-bump lands
half-done. **Fix:** derive the doc literal from `typeof CURRENT_SCHEMA_VERSION` and drop the cast.

### 2.5 Stale "mirror" comments pointing at code that no longer exists

- `applyMutation.ts:106-108` and `:460-461` reference `pruneWidgetColSpan` in `StudioCanvas` —
  that function was **deleted** (see `StudioCanvas.colSpanLeak.test.ts:17` "`pruneWidgetColSpan`
  was deleted…"; `StudioCanvas.tsx:206` says the reducer's `enforceLayoutColSpans` now governs
  all span cleanup).
- `applyMutation.ts:373-375` says the handler "Mirrors the client's
  `StudioController.removeWidget`" — inverted: the controller _delegates to this reducer_
  (`StudioController.ts:788-796`); there is no second implementation to mirror.

Not cosmetic: these comments instruct a future editor to keep this code in sync with copies that
don't exist, i.e. they re-create the duplication mindset the consolidation removed. **Fix:**
update the comments to state this file is the sole implementation.

### 2.6 "Zero-dependency" claim vs the `@mui/x-chat-headless` type import

- `src/aiTypes.ts:16` (`import type { ChatMessage } from '@mui/x-chat-headless'`),
  `package.json:19-21` (devDependency only), `src/index.ts:9` ("Zero runtime dependencies")

Type-only, so no runtime cost — but the package ships TypeScript source (`main: ./src/index.ts`),
so every consumer type-checks this import. A consumer without `@mui/x-chat-headless` installed
(the data middleware, a host app importing the schema directly) gets a broken `StudioAIChatThread`
/ `ai` surface, and `package.json` doesn't declare the requirement. The package description
("dependency-free"), CLAUDE.md, and the code disagree with reality. **Fix:** either inline a
minimal structural `ChatMessage` type here (making the claim true), or declare the dependency
honestly (peer/optional).

---

## Tier 3: God-Files / Cohesion

### 3.1 `StudioWidgetConfig` is a ~120-key flat bag shared by all widget kinds

- `packages/x-studio-schema/src/widgetTypes.ts:667-676` (and it is why the file is 726 lines)

Every widget of every kind carries the full key space of all eight kinds (`Partial<>` of each
per-kind interface, documented as historical). Consequences observable _inside this package_:
the reducer cannot type config writes (four `as StudioWidget['config']` /
`as Record<string, unknown>` casts in `updateWidget`/`applyBulkUpdate`), `validateWidget` can
never validate config beyond `isRecord` (`parseStateMutation.ts:100-124` explicitly gives up),
a `kind` change via `updateWidget.changes` leaves the old kind's keys behind as permanent
persisted dead weight, and typo'd config keys are silently legal. The per-kind interface split
already done is the right first step; the missing second step is a discriminated
`kind → config` union (with a migration) or at minimum a runtime `kind → allowed keys` map that
the validator and reducer can share. Until then, "shallow config validation" is not a choice but
a structural necessity.

### 3.2 `applyMutation.ts` (847 lines) is cohesive but `applyBulkUpdate` re-implements removal semantics

- `packages/x-studio-schema/src/applyMutation.ts:667-766`

The handler-table design is good (exhaustive mapped type, co-located labels). The one cohesion
wrinkle: `applyBulkUpdate` is a ~100-line second implementation of "remove these widget ids"
that shares only `dropWidgetScopedFilters`/`removeSpanEntries` with `removeWidget` — the
still-referenced logic, span pruning scope, and filter cleanup are re-derived inline, which is
already drifting (findings 1.5, 1.8). Extracting a single `removeWidgetIds(doc, ids)` primitive
used by `removeWidget`, `removePage`, and `applyBulkUpdate` would eliminate all three
inconsistencies at once.

### 3.3 Minor: `aiTypes.ts` mixes four concerns

Wire mutations, transport envelope, rich-context DTOs, and _persisted_ conversation state
(`StudioAIState`, which belongs conceptually with `stateTypes.ts` since it is a `StudioDoc`
field) share one file. Low priority; worth splitting only when the file next grows.

Beyond these, the tier is healthy: file sizes are modest, factories/persistence/parsing are
cleanly separated, and `statePersistence.ts` is fine at 303 lines.

---

## Tier 4: Testing Gaps

Ranked by risk. The existing suites are unusually strong (idempotency, proto-id hygiene,
reference-equality no-ops, doc-completeness round-trip are all pinned) — the gaps below track the
Tier 1 findings almost one-to-one, which is itself evidence they are real blind spots.

1. **`unsetFields` on required fields** — `applyMutation.test.ts:446-460` pins only
   `['id', 'config']`; there is no test for `['title']`/`['kind']`, so the 1.1 hole is invisible.
   A test asserting these are rejected/ignored would have caught it.
2. **`__proto__` as a patch _key_** — the proto-hygiene suites (`applyMutation.test.ts:1200-1273`,
   `parseStateMutation.test.ts:312-343`) cover ids only. No test feeds
   `JSON.parse('{"__proto__":{...}}')` into `updateWidget.args.config` and asserts
   `Object.getPrototypeOf(next.widgets.w1.config) === Object.prototype` (finding 1.2).
3. **Persistence failure modes** — no test passes a structurally-hollow-but-versioned object
   (`{ schemaVersion: 1 }`) through `migrateState` → `deserializeState` (crash path, 1.3); no
   test covers the missing-migration gap branch (`statePersistence.ts:210-216`, finding 1.4 —
   currently a bump-without-entry ships green); no multi-step migration-chain test exists (the
   sequential loop is only ever exercised for the trivial 0→1 stamp).
4. **`applyBulkUpdate` span hygiene** — no test feeds out-of-range/overflowing `widgetColSpans`
   (finding 1.8) or asserts `{}`-vs-`undefined` normalization; the tests only use already-valid
   spans.
5. **`temporalUtils` boundary inputs** — no test for offset-carrying datetimes
   (`'…+05:00'`, finding 1.6a) or impossible fast-path dates (`'2024-13-40'`, 1.6b); the suite
   only exercises `Z`/date-only strings, so the fast-path/fallback divergence is unobserved.
6. **Cross-page widget references in `removePage`** — `applyBulkUpdate`'s still-referenced case
   _is_ tested (`applyMutation.test.ts:1079-1124`) but the equivalent `removePage` scenario is
   not — the test asymmetry exactly mirrors the code asymmetry (finding 1.5).
7. **`addWidget` re-delivery after a cross-page move** (finding 1.7) — the idempotency test
   re-delivers into an unchanged state only.

Explicitly **low-value to test** (don't bother): cross-process `createWidgetId` collision odds
(unobservable, probabilistic), `detectAnomaliesIQR` with `NaN` inputs (degrades to
"no outliers", acceptable), the file-private `median` helper (already covered indirectly and
documented as such), and `mutationLabel` formatting beyond the existing pins.
