# Architecture review — iteration 5 (fresh, from scratch)

Scope: every file under `packages/x-studio-schema/src`, read exhaustively and cross-checked
against `ARCHITECTURE.md`. Baseline: all 358 unit tests in the package pass. The reducer's
purity/no-op discipline, the wire-boundary validator, the config-key allow-lists, and the
compile-time exhaustiveness locks all check out as documented — the findings below are
concentrated at the **persistence/load boundary**, which is markedly less hardened than the
wire boundary. Findings 1–3 were reproduced with a live script before being written up.

---

## Tier 1 — real bugs with concrete failure scenarios

### 1.1 `deserializeState` throws an uncaught `TypeError` on nested-corrupt docs that `migrateState` just approved

- **Files:** `src/statePersistence.ts:170-185` (`findMissingRequiredField`), `:380-415`
  (widget normalization loop), `src/applyMutation.ts:330-334` (`normalizePersistedPages`).
- **What happens:** `migrateState` fail-closes only on the four _top-level_ fields
  (`dashboard`/`pages`/`widgets`/`filters` present and of the right container type). Any
  corruption one level down passes it and then crashes `deserializeState`. Reproduced:
  - `pages: { p1: { id: 'p1', title: 'P', widgetRows: 'junk' } }` → `migrateState` returns
    `success: true`, then `deserializeState` throws `currentRows.map is not a function`
    (`normalizePersistedPages` line 332). A `null` page value or a non-array row inside
    `widgetRows` crashes the same way.
  - `widgets: { w1: null }` → `migrateState` succeeds, then `deserializeState` throws
    `Cannot read properties of null (reading 'config')` (statePersistence.ts line 388).
- **Why it's wrong:** it violates the package's own documented contract twice over.
  `migrateState`'s stated purpose is that a partial/corrupt persisted doc is "rejected here
  with a named field **rather than crashing later in `deserializeState`**"
  (ARCHITECTURE.md, `migrateState` section), and `normalizePersistedPages` exists precisely
  to be the defensive sweep for "a corrupted or hand-edited persisted doc" — yet it is the
  very function that throws on the first non-array shape it meets. A host app loading a
  truncated/hand-edited doc gets an uncaught exception (blank dashboard / error boundary)
  instead of a failed `MigrationResult` it can surface.
- **Fix direction:** either (a) make `normalizePersistedPages` and the widget-normalization
  loop total over junk (skip/drop a non-record page or widget entry; coerce a non-array
  `widgetRows` to `[]`; filter non-array rows), or (b) extend `findMissingRequiredField`
  to a shallow per-entry shape check (each `pages[*]` is a record with array `widgetRows`,
  each `widgets[*]` is a record with a record `config`), keeping the fail-closed error
  style. (b) matches the "named field" contract best. Add tests mirroring the existing
  `columns: "junk"` case (statePersistence.test.ts:436) for pages and null widgets.

### 1.2 Persisted `pages`/`widgets` record keys are never checked against `UNSAFE_KEYS`; the load sweep's bracket assignment silently drops a `"__proto__"` page and re-prototypes the pages map

- **Files:** `src/applyMutation.ts:354, 357` (`normalizePersistedPages`:
  `nextPages[pid] = …`), `:416-424` (`removeWidgetIds`: same pattern),
  `src/statePersistence.ts:380` (widgets rebuilt via `Object.fromEntries`, which
  _preserves_ an own `__proto__` key).
- **What happens:** the wire boundary rejects unsafe ids everywhere, and
  `normalizePersistedPages` guards `widgetColSpans` keys with `isSafePatchKey` — but the
  **page ids and widget ids of the persisted maps themselves** are never screened.
  `JSON.parse` happily produces an own `"__proto__"` key. Reproduced with
  `pages: { p1: …, "__proto__": { id: "evil", title: "Evil", widgetRows: [] } }` plus any
  other normalization churn on the doc: after `deserializeState`,
  `Object.hasOwn(doc.pages, '__proto__')` is `false` (the page is silently gone) and
  `Object.getPrototypeOf(doc.pages)` is the attacker-supplied page object — inherited
  properties leak (`doc.pages.title === 'Evil'` in the repro). The `[[Set]]` in
  `nextPages['__proto__'] = page` invokes the inherited accessor instead of creating an
  own key. Worse, the behavior is _inconsistent_: when no page needed fixing,
  `normalizePersistedPages` returns the original map and the own `"__proto__"` page key
  survives into live state — where it then flows into `removeWidgetIds`' identical
  `nextPages[pid] = p` rebuild on the next `removeWidget`/`removePage`/`applyBulkUpdate`,
  silently dropping the page and re-prototyping the map mid-session. A widgets record with
  an own `"__proto__"` key survives the load boundary entirely (Object.fromEntries) and
  then gets asymmetric treatment in the reducer (rows keep referencing it; a
  `setWidgetColSpan` for it is silently swallowed by the `newSpans[widgetId] = clamped`
  setter no-op).
- **Why it's wrong:** persisted docs are a real trust boundary (hand-edited files, shared
  dashboards — chatTypes.ts explicitly names "shareable dashboards" as a feature), and the
  package's own convention (`unsafeKeys.ts`) is that _every_ record rebuilt key-by-key from
  untrusted input is guarded. The pollution is contained to the pages record (not
  `Object.prototype`), but silent page loss plus a data-dependent prototype rewrite is
  corruption, and the "sometimes dropped, sometimes kept" inconsistency makes it worse.
- **Fix direction:** at the load boundary, drop `UNSAFE_KEYS`-keyed entries from both
  `pages` and `widgets` (one filter in `normalizePersistedPages` / the widget loop), and
  replace the two `nextPages[pid] = …` bracket-assignment rebuilds with
  `Object.fromEntries` (the form `removeWidget`'s row-edit pass already uses) so a stray
  unsafe key can never invoke the accessor. Pin with tests (persisted `"__proto__"` page
  and widget keys: entry dropped, `Object.getPrototypeOf(doc.pages) === Object.prototype`).

---

## Tier 2 — design inconsistencies / missing safeguards worth fixing

### 2.1 `migrateState` fails **open** for `schemaVersion: NaN`

- **File:** `src/statePersistence.ts:203` (`fromVersion` derivation), `:269` (loop).
- **What happens:** `typeof NaN === 'number'`, so `fromVersion = NaN`; `NaN === CURRENT`
  is false, `NaN > CURRENT` is false, and the `for (version = NaN; version < CURRENT; …)`
  loop never runs — reproduced: `migrateState({ schemaVersion: NaN, …valid fields })`
  returns `success: true` with `fromVersion: NaN` and the state passed through
  **un-migrated**. This is the one hole in the otherwise fail-closed version handling
  (JSON-representable non-integers like `0.5`/`-1` do fail closed, though via a confusing
  "No migration registered from v0.5" gap error). `NaN` cannot come from `JSON.parse`, but
  `migrateState(state: unknown)` is a public API and in-process callers can feed it
  computed values.
- **Fix direction:** gate with `Number.isInteger`: an integer number → use it; `undefined`
  → 0 (legacy); anything else → a hard `{ success: false }` naming `schemaVersion`. Add a
  test for `NaN` and a non-integer.

### 2.2 `deserializeState` installs persisted `filters` verbatim — the serialize-side strip of `cross-filter`/`interactive` scopes has no load-side counterpart

- **File:** `src/statePersistence.ts:434` (`filters: serialized.filters`), vs
  `serializeDoc`'s strip at `:349-351`.
- **What happens:** `serializeDoc` guarantees those two session-flavoured scope kinds never
  reach disk, but a hand-edited or foreign doc that carries them anyway loads them straight
  into live `doc.filters`. A cross-filter whose `scope.sourceWidgetId` names a widget that
  doesn't exist in the doc is then permanently active: the reducer's cleanup for such
  filters only fires when the source widget is _removed_, and it was never present — the
  scoped page loads pre-filtered with no surviving affordance to clear it.
- **Fix direction:** apply the same scope predicate on load (filter out
  `cross-filter`/`interactive` entries in `deserializeState`), making the boundary
  symmetric the way the "empties are omitted / re-defaulted" fields already are. One test:
  a serialized doc hand-carrying a cross-filter entry deserializes without it.

### 2.3 Missing test coverage for the load-boundary hardening that exists (and the gaps above)

- **File:** `src/statePersistence.test.ts`.
- The suite pins the happy paths and several corruption cases (non-array `columns`, phantom
  rows, out-of-range spans) but has nothing for: non-array `widgetRows` / null page / null
  widget (1.1), unsafe own keys in `pages`/`widgets` (1.2), `NaN`/non-integer
  `schemaVersion` (2.1), or persisted cross-filter entries on load (2.2). Whatever fix
  direction is chosen, these are the regression tests to add; they are cheap and all
  load-bearing for the "persisted docs are untrusted" posture.

---

## Tier 3 — minor / cosmetic

### 3.1 `normalizeChartSeries` converts a junk `seriesType: null` into a junk canonical `type: null`

- **File:** `src/factories.ts:183-191`. The early return only checks
  `series.seriesType === undefined`; a `null` alias (possible via the unvalidated config
  leaf) falls through and produces `{ …, type: null }` — the junk is _promoted_ into the
  canonical field instead of being stripped. Harmless downstream today (`type ?? 'bar'`
  readers treat `null` as… actually `??` does treat `null` as absent, so behavior is fine),
  but the normalizer's contract says the result "always expresses the render kind through
  `type`". Treat a nullish alias as absent (`series.seriesType == null`).

### 3.2 Wire-boundary id checks are inconsistently strict for the optional targeting ids

- **File:** `src/parseStateMutation.ts:310, 397, 421, 525`. Every _required_ page/widget id
  uses `isSafeId`, but the optional server-chosen targeting fields (`addWidget.pageId`,
  `setWidgetLayout.pageId`, `setWidgetColSpan.pageId`, `renameAIThread.threadId`) are only
  `isOptionalString`. Benign today — all four are consumed via `Object.hasOwn` lookups and
  object-literal computed-key writes — but the asymmetry invites a future handler to
  bracket-assign one of them. Cheap uniformity fix: an `isOptionalSafeId` helper.

### 3.3 `addWidget` lacks the `isSafePatchKey` defense-in-depth guard its sibling bulk-insert path has

- **File:** `src/applyMutation.ts:520-541` vs `:1176` (`applyBulkUpdate.addedWidgets`).
  The insert itself is safe (object-literal computed key creates an own property), but the
  asymmetry means a parser-bypassing server-built `addWidget` with an unsafe id _succeeds_
  where the identical widget via `applyBulkUpdate` is skipped — and the resulting own
  `"__proto__"` widgets key then gets the inconsistent downstream treatment described in
  1.2. Mirror the bulk path's skip.

### 3.4 `applyBulkUpdate` drops the entire delta when `activePageId` is stale

- **File:** `src/applyMutation.ts:1084-1086`. If the target page was deleted mid-turn, the
  whole mutation — including the page-independent `removedWidgetIds`/`addedWidgets`/
  `updatedWidgets` deltas the lost-update-safe shape exists to preserve — is a silent
  no-op. Arguably the safest default, but it's undocumented in `mutationTypes.ts`, whose
  doc comment implies only the _layout_ is scoped to `activePageId`. Either apply widget
  deltas independently of the layout replacement, or document the all-or-nothing guard.

### 3.5 `dashboard.activePageId` is not reconciled at the load boundary

- **File:** `src/statePersistence.ts:424`. A persisted doc whose `activePageId` names a
  missing page loads verbatim (blank canvas until the user switches pages). `removePage`
  maintains this invariant live; `normalizePersistedPages` (or `deserializeState`) could
  reassign to the first page the same way `removePage` does.

### 3.6 `removeWidget` churns the `pages` map reference unconditionally

- **File:** `src/applyMutation.ts:735-766`. `Object.fromEntries` over all pages mints a
  fresh map even for a widget that sits on no page; the doc changes anyway (the widget
  entry is deleted), so no contract is violated — just off-pattern next to the meticulous
  reference stability everywhere else in the file.

### 3.7 `serializeDoc` emits explicit `undefined`-valued keys for the omitted empties

- **File:** `src/statePersistence.ts:352-355`. Invisible after `JSON.stringify`, but the
  in-memory `SerializedStudioState` handed to `StudioController`'s undo snapshots carries
  own `relationships`/`expressionFields`/`filterPresets`/`ai` keys with `undefined` values
  (visible to `Object.keys`/`structuredClone` consumers). Conditional spreads would make
  the in-memory and on-disk shapes identical. Cosmetic.

---

## ARCHITECTURE.md accuracy

The document is current and accurate against the code with two overstatements, both
consequences of the Tier 1/2 findings rather than independent staleness:

- The `migrateState` section's claim that a corrupt doc is "rejected here with a named
  field rather than crashing later in `deserializeState`" holds only for the four
  top-level fields (see 1.1), and "fail-closed at four points" has the `NaN` hole (2.1).
- The `normalizePersistedPages` description ("defensive sweep for a corrupted or
  hand-edited persisted doc") oversells its totality: it crashes on non-array shapes (1.1)
  and mishandles unsafe page keys (1.2).

Everything else re-verified as true: the reducer touches only `StudioDoc`; no
`Date.now()`/`Math.random()` inside any handler (ids/timestamps are producer-supplied or
factory-minted outside the reducer); every handler honors the reference-equality no-op
contract as described; the three mapped-type exhaustiveness locks and the two
`AssertKeysCovered`/`AssertChartTypesCovered` compile locks are present; `MUTATION_TYPES` /
`PARSEABLE_MUTATION_TYPES` match; the id factories, IQR math, and temporal fast-path
behave as documented (including the documented calendar-validity carve-out).
