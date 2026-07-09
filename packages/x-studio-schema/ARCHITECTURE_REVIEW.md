# Architecture Review — `@mui/x-studio-schema` (iteration 3)

Fresh, adversarial, from-scratch read of every file in `packages/x-studio-schema/src/`.
Prior review history was deliberately NOT consulted; `ARCHITECTURE.md`'s correctness
claims were treated as claims to falsify, not facts.

## Summary

Baseline is green: `tsc -p tsconfig.json` is clean and the package test suite passes
(**7 files, 327 tests**, via `vitest --config vitest.config.node.mts --run`). The reducer
(`applyMutation.ts`), the wire-validation gate (`parseStateMutation.ts`), and the
persistence boundary (`statePersistence.ts`) are unusually well-hardened: prototype-key
guards, `Object.hasOwn` existence checks, reference-equality no-op contracts, and
cross-page removal invariants all hold up under adversarial probing.

- **Tier 1 (correctness/security):** Nothing actionable found. Prototype-pollution
  vectors, idempotency/no-op contracts, col-span overflow/rebalance math, cross-page
  widget/filter cleanup, and migration fail-closed paths were probed empirically and all
  behave as documented. Details of what was tried are in the Tier 1 section.
- **Tier 2 (design smells):** One genuine validation-boundary inconsistency — full-widget
  payloads (`addWidget` / `applyBulkUpdate.addedWidgets`) do **not** validate the optional
  scalar widget fields (`titleMode`/`subtitleMode`/`subtitle`/`sourceId`) that
  `updateWidget.changes` validates strictly, so junk values persist over the wire.
- **Tier 3 (minor/cosmetic):** `hasUnsafeOwnKeys` is not applied to full-widget `config`
  (harmless today, verified no live pollution); `relationships` is always serialized even
  when empty (asymmetric with `expressionFields`/`filterPresets`); a latent
  `changes.config === null` defense-in-depth edge in the reducer.

---

## Tier 1 — Correctness & Security

**No actionable findings.** This is a genuine "tried hard, found nothing" — the following
were each investigated and empirically checked where feasible:

1. **Prototype pollution via wire payloads.** Every reducer site that writes a record key
   from untrusted input (`updateWidget` config/changes loops, `applyBulkUpdate` span
   rebuild + added-widget inserts, `setWidgetColSpan` sibling rebalance, `removeSpanEntries`)
   is guarded by `isSafePatchKey`/`Object.hasOwn`, and `parseStateMutation` rejects
   `__proto__`/`constructor`/`prototype` at the boundary. I confirmed a
   `JSON.parse('{"__proto__":…}')`-sourced chart config is rejected (own-key allow-list),
   and that even the one payload that slips through the wire gate (custom-kind config with
   an own `__proto__` key — see Tier 3) causes **no** actual pollution: `({}).polluted`
   stays `undefined` because the config is stored wholesale and every later reconstruction
   uses object spread (`CreateDataProperty`, which never invokes the `__proto__` setter),
   not bracket assignment.

2. **Idempotency / reference-equality no-op contract.** `addPage`/`addWidget`/`addFilter`
   re-delivery, `setActivePage`/`setDashboardTitle`/`renamePage` identical writes,
   `setWidgetColSpan`/`setWidgetLayout` value-equal span/row writes, `renameAIThread`
   unresolvable-thread, and `applyBulkUpdate` no-change all return the **same** `state`
   reference. The `rowsEqual`/`spansEqual`/`shallowRecordEqual` helpers correctly back the
   no-op detection where a fresh-but-equal object is minted. No path was found that pushes
   a spurious undo entry.

3. **Col-span overflow / rebalance.** `clampSpan` guards non-finite input (→ `MIN_SPAN`,
   not a `null`-serializing `NaN`); `enforceLayoutColSpans`'s three invariants (2→1
   collapse gated on `oldRowLen >= 2`, row-overflow drop, orphaned-span drop) and
   `setWidgetColSpan`'s single-sibling-shrink vs. multi-sibling-clear branches are
   internally consistent and reach the same unit system (`GRID_COLS = 24`) the canvas uses.

4. **Cross-page removal cleanup.** `removeWidgetIds` recomputes `stillReferenced` from the
   post-edit page rows, so a widget shared across pages keeps its `widgets` entry, filters,
   and spans; `removeWidget`/`removePage`/`applyBulkUpdate` all converge on it. Filter
   dropping (`widget`/`interactive`/`cross-filter` scope) and homeless page-scoped filter
   removal in `removePage` are correct.

5. **Migration / persistence fail-closed.** `migrateState` hard-fails on a registry gap or
   a newer-than-current version, deep-copies via `structuredClone` before mutating, and
   validates required fields both on the fast path and post-migration.
   `deserializeState`'s legacy `columns`/`ySeries` normalization is `Array.isArray`-guarded
   (a corrupt `columns: "junk"` is left untouched, not crashed on `.map`).

6. **`temporalUtils` UTC bucketing.** The `toUtcYMD` fast-path offset detection
   (`!tail.includes('+') && !tail.includes('-')`) correctly routes offset-carrying strings
   to the `new Date` fallback; the deliberate "written wall-clock components as UTC" fast
   path is self-consistent for the values that hit it.

---

## Tier 2 — Design smells

### T2.1 — Full-widget wire payloads skip optional-scalar-field validation (`parseStateMutation.ts` `validateWidget`, lines 138–189)

`validateWidget` checks only `id`, `kind`, `title`, and `config` (plus per-kind config
keys). It does **not** validate the other top-level `StudioWidgetOf` fields —
`titleMode`, `subtitleMode`, `subtitle`, `sourceId` — even though `updateWidget.changes`
validates them strictly and with an explicit rationale (`isOptionalTitleMode` exists
_specifically_ so "a junk value … can't persist into a field the client's auto-title logic
branches on", parseStateMutation.ts lines 56–62 / 314–323).

Because `validateWidget` backs both `addWidget.args.widget` and
`applyBulkUpdate.addedWidgets[]`, the same junk the `updateWidget` path rejects sails
through the `addWidget` path and is persisted verbatim by the reducer (which stores the
widget wholesale). Empirically confirmed:

```
parseStateMutation({ type:'addWidget', args:{ widget:{
  id:'w1', kind:'chart', title:'X', config:{chartType:'bar'}, titleMode:42, sourceId:99 }}})
  -> { ok: true }                     // accepted at the wire boundary
applyMutation(...).doc.widgets.w1
  -> {"id":"w1","kind":"chart","title":"X","config":{"chartType":"bar"},"titleMode":42,"sourceId":99}

parseStateMutation({ type:'updateWidget', args:{ widgetId:'w1', changes:{ titleMode:42 }}})
  -> { ok:false, error:"updateWidget.args.changes.titleMode must be 'auto' or 'manual' when present" }
```

`titleMode: 42` (a non-`'auto'`/`'manual'` value) and `sourceId: 99` (a number, where a
source-id lookup key is expected) are now in persisted state. Severity is moderate — the
SSE producer is semi-trusted and this is the only wire entry point — but it is precisely
the class of "forward-incompatible / malformed payload" the gate exists to reject, and the
two sibling mutation paths disagree about whether it is acceptable.

**Fix sketch:** in `validateWidget`, add `isOptionalString(widget.subtitle)`,
`isOptionalString(widget.sourceId)`, and `isOptionalTitleMode(widget.titleMode)` /
`isOptionalTitleMode(widget.subtitleMode)` checks, mirroring the `updateWidget.changes`
block. This closes the asymmetry with one shared set of leaf predicates already defined in
the file.

---

## Tier 3 — Minor / cosmetic

### T3.1 — `hasUnsafeOwnKeys` is not applied to full-widget `config` (`parseStateMutation.ts` `validateWidget`)

Every _other_ config-carrying arg runs `hasUnsafeOwnKeys` at the wire boundary
(`updateWidget.config`, `updateWidget.changes.config`, `applyBulkUpdate.updatedWidgets[].config`,
`applyBulkUpdate.widgetColSpans`), but `addWidget`/`addedWidgets` widget `config` does not.
For a **known** kind an own `__proto__` key is incidentally rejected by the per-kind
allow-list (`validateConfigKeysForKind` flags it as a stray key). For a **custom** kind the
allow-list returns `null` ("anything goes"), so an own `__proto__` config key is accepted:

```
parseStateMutation(JSON.parse('{"type":"addWidget","args":{"widget":{"id":"w2",
  "kind":"acme-x","title":"T","config":{"__proto__":{"polluted":true}}}}}'))
  -> { ok: true }; stored config keys -> ['__proto__']; ({}).polluted -> undefined
```

It is **not** a live pollution vector today (verified above — the config is stored as data
and only ever spread, never key-rebuilt from stored state), so this is defense-in-depth
consistency, not a bug. Applying `hasUnsafeOwnKeys(widget.config)` inside `validateWidget`
would make the boundary uniform and remove the "harmless only because nothing downstream
rebuilds this record key-by-key" caveat.

### T3.2 — `relationships` always serialized even when empty (`statePersistence.ts` `serializeDoc`, line 321–332)

`serializeDoc` spreads `...rest` (which carries `relationships`) and then explicitly
omits-when-empty only `expressionFields`, `filterPresets`, and `ai`. So an empty
`relationships: []` is always written to persisted JSON, while the other empty collections
are dropped. `SerializedStudioState.relationships` is optional and `deserializeState` does
`?? []`, so this round-trips correctly — it is purely an inconsistency in the on-disk shape
(slightly larger payloads, and a reader can't distinguish "no relationships" from "field
present"). Either omit it when empty for symmetry, or document that `relationships` is
deliberately always-present.

### T3.3 — Latent `changes.config === null` handling in the reducer (`applyMutation.ts` `updateWidget`, lines 551–558)

The `changes.config` branch's `else if (value !== updated.config)` path would assign
`config = null` for a `changes: { config: null }`. `parseStateMutation` rejects this at the
wire boundary (`isRecord` check), so it is only reachable by a server-built mutation that
bypasses the parser — and `changes.config` is typed non-nullable, so a producer would have
to defeat its own types. Very low severity, but the reducer's defense-in-depth stance
elsewhere (unsafe-key guards for exactly the "server bypasses the parser" case) makes the
missing `value && typeof value === 'object'` guard here a small inconsistency worth a
one-line hardening.

---

## Notes on documented tradeoffs (checked, found deliberate & correct)

- **Key retention across `chartType` switches** — the flat `StudioChartConfig` keeping
  other-family keys (e.g. `sankeyTargetField` on a now-`gauge` config) is intentional UX
  driven by the reducer's merge (patch, not replace) semantics. `validateWidget`'s
  stateless family check is correctly documented as safe only because no producer currently
  round-trips a stored widget through `addWidget`/`addedWidgets`, with `stripForeignFamilyKeys`
  provided as the sanctioned future escape hatch. Correct as designed.
- **Reducer confined to `StudioDoc`** — the compile-time access boundary (handlers can't
  reach `session`/`runtime`) holds; the `applyMutation` wrapper preserves whole-state
  reference equality.
- **`CURRENT_SCHEMA_VERSION` living in `stateTypes.ts`** — the cycle-avoidance rationale
  (`factories.ts` needs the runtime value; importing from `statePersistence` would cycle)
  is real; the re-export keeps import sites stable.
- **`toUtcYMD` fast path treating written components as UTC** — deliberate and self-consistent
  for offset-free strings; offset-carrying strings correctly fall back to `new Date`.
- **`removePage` setting `activePageId = ''`** when the last page is removed mirrors
  `StudioController` and is an expected degenerate state, not a defect.
- **`detectAnomaliesIQR` guards** (`length < 4`, zero IQR) and the private, pre-sorted-input
  `median` helper's non-export are intentional and correct.
