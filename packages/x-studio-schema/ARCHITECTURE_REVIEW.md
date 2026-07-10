# x-studio-schema Architecture Review — Iteration 9

Fresh, ground-up review of `packages/x-studio-schema/src` (every file read in full) and cross-check
of `ARCHITECTURE.md` against the current code. Prior 8 rounds have hardened this package heavily;
this pass re-derived everything from source rather than assuming prior findings still apply.

**Result: 0 Tier 1, 1 Tier 2.**

The prompt specifically asked to hunt for _other_ dispatch-style / bracket-access lookups keyed by
user/wire-controlled data that share the prototype-chain hazard iteration 8 fixed in two spots
(`MUTATION_HANDLERS[type]` / `mutationLabel`). That hunt found exactly one un-hardened sibling.

---

## Tier 2

### T2-1 — `getAllowedChartConfigKeys` bracket-lookup is not prototype-chain-guarded; the documented fail-closed contract throws instead of degrading

**File:** `packages/x-studio-schema/src/configKeyValidation.ts:486-488` (`getAllowedChartConfigKeys`),
propagating to `validateChartConfigKeysForType` (`:504-510`) and `stripForeignFamilyKeys` (`:528-540`).

**What's wrong.** The chart-type-level allow-list resolver reads the config-key table with a bare
bracket access on a plain object literal:

```ts
export function getAllowedChartConfigKeys(chartType: StudioChartType): Set<string> {
  return new Set<string>(CHART_TYPE_CONFIG_KEYS[chartType]); // ← unguarded lookup
}
```

`CHART_TYPE_CONFIG_KEYS` is an ordinary object (`Record<StudioChartType, readonly string[]>`, no null
prototype). For a `chartType` string that names an `Object.prototype` member —
`'constructor'`, `'toString'`, `'valueOf'`, `'hasOwnProperty'`, `'__proto__'` — the lookup does **not**
resolve to `undefined`. It resolves _up the prototype chain_ to a `Function` (e.g.
`Object.prototype.constructor`) or to `Object.prototype` itself. `new Set(<function>)` /
`new Set(Object.prototype)` then throws `TypeError: ... is not iterable`, because a function/plain
object is not iterable.

This directly contradicts the function's own documented contract. `validateChartConfigKeysForType`'s
JSDoc (`:495-499`) states: _"passing a string that is not a real `StudioChartType` yields an empty
allow-list and thus flags every key, which is the intended fail-closed behavior for an unknown chart
type (there is no permissive mode)."_ That is true for an ordinary unknown string (`'trendline'` →
`CHART_TYPE_CONFIG_KEYS['trendline']` is `undefined` → `new Set(undefined)` is an empty set,
fail-closed). It is **false** for prototype-chain member names, which throw mid-validation instead of
returning an empty allow-list.

**This is the exact sibling class iteration 8 fixed.** Every _other_ table lookup in the package
guards the bracket read with `Object.hasOwn` first — including the kind-level function _directly above
this one in the same file_:

```ts
export function getAllowedConfigKeys(kind: StudioWidgetKind): Set<string> | null {
  if (!Object.hasOwn(BUILTIN_OWN_CONFIG_KEYS, kind)) {   // ← guarded
    return null;
  }
  ...
}
```

`getAllowedChartConfigKeys` is the one table resolver that omits the guard, an internal
inconsistency, not a deliberate asymmetry (the JSDoc explicitly _intends_ fail-closed behavior for
unknown input — it just doesn't achieve it for prototype names).

**Concrete failure scenario.** The function is a public export (`index.ts:52-58`) whose JSDoc invites
callers to pass an untrusted string and rely on fail-closed handling. A real consumer does exactly
that _without_ an `isStudioChartType` gate:

- `packages/x-studio/src/store/StudioController.ts:1310-1318` (`updateWidgetConfig`) computes
  `effectiveChartType = patchChartType ?? resolveChartType(existingWidget.config)` and passes it
  straight to `validateChartConfigKeysForType`, casting via `as StudioChartType`. Neither
  `patchChartType` (from the incoming config patch) nor `resolveChartType`'s return (from stored
  config — just `config.chartType ?? 'bar'`, unvalidated) is checked against `isStudioChartType`.
  So a config whose `chartType` is `'constructor'` (a crafted `updateWidgetConfig`/AI patch, or a
  hand-edited/shared persisted doc whose stored `chartType` was tampered) reaches
  `validateChartConfigKeysForType('constructor', …)` → `getAllowedChartConfigKeys('constructor')` →
  `new Set(Object.prototype.constructor)` → **thrown `TypeError`**, crashing the client-side config
  write instead of the controller's documented warn-and-strip degradation.

(The schema-internal caller — `parseStateMutation.ts`'s `validateWidget`, `:237-249` — is _not_
affected: it gates the chart type with `isStudioChartType` before calling the validator, so an
`addWidget`/`addedWidgets` payload with `chartType: 'constructor'` is rejected earlier. Likewise the
middleware's `executeToolOnState.invalidChartConfigKeyError` and x-studio's
`sanitizeServerWidgetConfig` both gate with `isStudioChartType`. The gap is the _unguarded public
function itself_ plus the one consumer, `StudioController.updateWidgetConfig`, that trusts the
documented fail-closed contract without gating.)

**Severity rationale (why Tier 2, not Tier 1).** This is a prototype-chain _read_ that throws — a
crash / broken-contract robustness gap — not prototype _pollution_ (no write, no privilege
escalation). But it is a genuine, precise, actionable defect: the documented fail-closed contract is
false, a live consumer depends on it, and it is the direct un-hardened sibling of the exact lookup
class iteration 8 was chartered to eliminate.

**Suggested fix.** Add the same `Object.hasOwn` guard the kind-level resolver uses, so an
unrecognized (or prototype-member) `chartType` yields the documented empty allow-list instead of
throwing:

```ts
export function getAllowedChartConfigKeys(chartType: StudioChartType): Set<string> {
  if (!Object.hasOwn(CHART_TYPE_CONFIG_KEYS, chartType)) {
    return new Set<string>(); // fail-closed: flags every key, as the JSDoc promises
  }
  return new Set<string>(CHART_TYPE_CONFIG_KEYS[chartType]);
}
```

`stripForeignFamilyKeys` (`:528-540`) inherits the same fix through `getAllowedChartConfigKeys`
(currently no call site, but it is a public export with the same latent hazard, so it is covered by
the single fix). Optionally, add a regression test mirroring `parseStateMutation`'s / the reducer's
`'constructor'`/`'__proto__'` pins: assert `getAllowedChartConfigKeys('constructor' as any)` and
`validateChartConfigKeysForType('toString' as any, {...})` return an empty allow-list / flag-all
result rather than throwing.

---

## What was checked and cleared (no finding)

**Reducer (`applyMutation.ts`) — every id-keyed write is guarded.** Swept every dynamic bracket
lookup/assignment:

- `MUTATION_HANDLERS[mutation.type]` / `mutationLabel` — `Object.hasOwn`-gated (`:1508`, `:1536`).
- `state.pages[pageId]` / `state.widgets[widgetId]` reads across `addWidget`, `updateWidget`,
  `removeWidget`, `setWidgetLayout`, `setWidgetColSpan`, `renamePage`, `removePage`, `setActivePage`,
  `applyBulkUpdate` — all preceded by an `Object.hasOwn` existence guard.
- Record _writes_ — `nextConfig[key]`, `nextWidgets[widget.id]`, `newSpans[otherId]`,
  `{ ...pages, [id]: … }`, `{ ...widgets, [widget.id]: … }` — all gated by `isSafePatchKey`
  (`addPage :544`, `addWidget :592`, `updateWidget` config loop `:687`, `setWidgetColSpan`
  sibling-shrink `:1028`, `applyBulkUpdate.addedWidgets` `:1344` and span rebuild `:1292`).
- Span-sum reads use `Object.hasOwn(next, id) ? next[id] : 0` (`enforceLayoutColSpans :318`,
  `setWidgetColSpan :1015`) so an untrusted row-mate id can never poison the sum with a
  prototype-member value.
- `delete`-based paths (`unsetConfigKeys`, overflow span drops) operate on `Object.hasOwn`-confirmed
  own keys; a `delete` of a prototype key is inert.

**Doc/session/runtime partition integrity.** Handlers are typed `(doc: StudioDoc) => StudioDoc`;
they structurally cannot reach `session`/`runtime`. `applyMutation` rewraps only `state.doc`. No
partition-boundary violation. Reference-equality no-op contract is honored on every handler (verified
each early-return-`state` path), including the merge handlers (`updateWidget.changes`,
`applyBulkUpdate.updatedWidgets`) via `shallowRecordEqual`/`rowsEqual`/`spansEqual`.

**Determinism / purity.** No `Date.now()`/`Math.random()`/I/O in any reducer handler.
`renameAIThread` takes a producer-stamped `updatedAt` rather than calling `new Date()`. The only
time/random use is in `factories.ts` (`makeIdFactory`, `createMutationEnvelope`), which are
non-reducer factories by design.

**Persistence / migration (`statePersistence.ts`).**

- `migrateState` derives the source version fail-closed (`Number.isInteger` guard rejects
  `NaN`/fractional/non-number; negative versions hit the registry-gap hard failure; newer-than-current
  refused). `structuredClone` wrapped in try/catch. Registry gaps are hard failures. `findMissingRequiredField`
  validates one level down (`pages[*].widgetRows`, `widgets[*].config`, `filters[*].scope.kind`) on
  both the post-migration and already-current paths.
- `deserializeState` screens widget-record keys via `isSafeKey`, drops non-record entries, reconciles
  `widget.id`↔key and coerces non-record `config` to `{}`, filters cross-filter/interactive and
  non-record/scope-less filters, validates `doc.ai` at container + per-entry level, coerces
  non-array `relationships`/`expressionFields`/`filterPresets` to `[]`, reconciles dangling
  `activePageId`. `normalizePersistedPages` drops unsafe page keys, coerces junk rows/spans, dedupes,
  clamps, reconciles page.id↔key, rebuilds via `Object.fromEntries`. No silent data-loss path found.
- `serializeDoc` spreads all doc fields (new fields carried automatically), strips
  cross-filter/interactive, collapses empty optional collections. Symmetric with the load boundary.

**Type-system / validation symmetry (AI-tool boundary vs. UI-mutation boundary).** The full-widget
create path (`validateWidget`) applies kind-level _and_ chart-type-level key checks with the
`?? 'bar'` fallback, matching the middleware's `buildWidgetFromArgs` and x-studio's
`sanitizeServerWidgetConfig`. Update patch channels get the narrower membership-only
`hasInvalidChartTypeInConfig` check on all three (`config` / `changes.config` /
`updatedWidgets[].config`). `isSafeId`/`hasUnsafeOwnKeys` applied to every id and config-carrying arg,
including custom-kind configs. The only asymmetry surfaced is T2-1 (the chart-type resolver's missing
prototype-chain guard, which the parser path happens to avoid via its `isStudioChartType` pre-gate
but the UI controller path does not).

**Other bracket lookups (`factories.ts`, `parseStateMutation.ts`).**
`BUILTIN_WIDGET_DEFAULTS[kind]` (`:125`), `BUILTIN_OWN_CONFIG_KEYS[kind]` (`:435`),
`FILTER_SCOPE_REQUIRED_IDS[kind]` (`:273`), `MUTATION_ARG_VALIDATORS[type]` (`:629`) — all
`Object.hasOwn`-gated. `CHART_TYPE_CONFIG_KEYS[chartType]` is the sole exception (T2-1).

**Pure helpers.** `normalizeChartSeries` (nullish-alias handling, reference stability),
`detectAnomaliesIQR` (`< 4` and zero-IQR guards), `truncateToPeriod`/`isoWeek` (offset-free fast
path with range check + `Date` fallback) — all reviewed, no correctness gaps.
