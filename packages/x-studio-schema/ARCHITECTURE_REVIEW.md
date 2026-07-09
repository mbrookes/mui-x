# Architecture / tech-debt review — `@mui/x-studio-schema`

Independent adversarial review of the package as it stands on this branch. Every finding
below was traced through the current source (not docs or prior review summaries), and the
Tier 1 findings were additionally confirmed empirically by running probe mutations through
`applyDocMutation` (probe file not committed).

Verification at review time: `tsc -p tsconfig.json` clean; `vitest --project "x-studio-schema" --run`
green (7 files, 310 tests).

---

## Tier 1: Correctness & Security

No security findings. The prototype-pollution defenses (wire rejection in
`parseStateMutation` + `isSafePatchKey`/`Object.hasOwn` defense-in-depth in the reducer)
were probed and hold on every id-keyed write path. The three findings below are
correctness gaps in the reducer's own documented contracts — none corrupts data; the
observable symptom is spurious undo entries / phantom layout entries.

### 1.1 `updateWidget`'s `changes` merge violates the reference-equality no-op contract (value-identical merge churns the doc)

`src/applyMutation.ts`, `updateWidget.apply`, the `changes` branch (~lines 503–528).

The `config`-patch branch tracks _actual_ change (`changedConfig` flips only when a key's
value differs or a present key is deleted), and `unsetConfigKeys`/`unsetFields` do the
same. The `changes` branch does not: it collects every defined, safe, non-`id` key into
`definedChanges` and rewraps the widget whenever `Object.keys(definedChanges).length > 0`
— **without comparing values against the existing widget**. So:

```ts
// widget w1 already has title 'Same'
applyDocMutation(doc, {
  type: 'updateWidget',
  args: { widgetId: 'w1', changes: { title: 'Same' } },
});
// → returns a NEW doc reference (confirmed empirically), not `doc`
```

Consequences, per the file's own contract doc (lines 1111–1113: "when a mutation changes
nothing … the SAME `doc` reference is returned"):

- `StudioController.commitDocPatch` pushes a spurious undo entry — the next Ctrl+Z is a
  visible no-op. This is precisely the failure mode the contract exists to prevent, and
  an LLM re-issuing an `update_widget` with the current title is a realistic producer.
- `executeToolOnState`'s unchanged-commit short-circuit misses, so a change-free
  mutation is still streamed/committed.

`ARCHITECTURE.md` (the `updateWidget` bullet) is also factually wrong on this point: it
claims "Each of the three rewrap-triggering branches — the `config` patch, the `changes`
merge, and `unsetConfigKeys` — tracks whether it actually changed a key (not just
attempted to)". The `changes` merge tracks _attempts_, not changes.

Fix sketch: in the `definedChanges` loop, skip a key when
`Object.hasOwn(updated, key) && updated[key] === value` (scalar fields — `title`,
`subtitle`, `sourceId`, `kind`, `titleMode`, `subtitleMode` — are all reference/value
comparable; a wholesale `changes.config` can be compared key-by-key the same way the
`config`-patch branch already does).

### 1.2 `applyBulkUpdate.updatedWidgets` is not idempotent: any matched update entry unconditionally churns the doc

`src/applyMutation.ts`, `applyBulkUpdate.apply` (~lines 1010–1037).

Every `updatedWidgets` entry whose `widgetId` exists rewraps the widget and sets
`widgetsChanged = true` unconditionally — even a **field-less** entry
(`{ widgetId: 'w1' }`) or a value-identical one (`{ widgetId: 'w1', title: <current title> }`).
Both were confirmed empirically to return a new doc reference.

The handler carefully guards every _other_ delta against re-delivery: adds are
existence-checked ("a re-delivered bulk … must be a no-op"), removals no-op via
`removeWidgetIds`, and the layout is value-compared via `rowsEqual`/`spansEqual`. Updates
are the one delta with no such guard, so an SSE at-least-once re-delivery of a bulk
envelope that carries `updatedWidgets` always pushes a spurious undo entry — despite the
handler's own closing comment ("a bulk that removed nothing, added/updated no widget …
returns the SAME doc") and `ARCHITECTURE.md`'s "Every handler honors the
reference-equality no-op contract … `applyBulkUpdate` (nothing removed, added, updated,
or laid out differently)". The existing test only covers `updatedWidgets: []`.

Fix sketch: build the patched widget, compare each applied field (and merged config keys)
against `existing`, and only assign/flag when something differed — same pattern as
`updateWidget`'s `config` branch.

### 1.3 `applyBulkUpdate` installs `widgetRows` verbatim — no phantom-widget sanitization (inconsistent with `setWidgetLayout`)

`src/applyMutation.ts`: compare `setWidgetLayout.apply` (~lines 678–681, added as a prior
round's fix "2.2": rows are filtered to ids present in `state.widgets`, and the guard is
pinned by a dedicated test) with `applyBulkUpdate.apply` (~lines 952–960), which installs
`args.widgetRows` on the active page **verbatim**.

A row id that is neither an existing widget nor among the bulk's `addedWidgets` persists
in `page.widgetRows` with no `widgets` entry — confirmed empirically
(`widgetRows: [['w1', 'ghost-widget']]` survives intact while
`Object.hasOwn(next.widgets, 'ghost-widget')` is `false`). That is exactly the "page
rendering a widget that does not exist" state the `setWidgetLayout` guard was added to
prevent, and the bulk producer is the _more_ likely source of it: it computes rows from a
turn-start snapshot, so a widget the user deletes mid-agentic-turn leaves a stale id in
the bulk's rows. (A skipped unsafe-id `addedWidgets` entry, e.g. `id: '__proto__'` on the
server-built path, similarly leaves its row entry behind.)

Note the fix cannot filter against `state.widgets` alone — rows legitimately reference
`addedWidgets` ids inserted later in the same handler. Sanitize against
`state.widgets ∪ {addedWidgets ids that pass isSafePatchKey}` (removal candidates are
resolved afterwards by `removeWidgetIds` and need no special-casing), then feed the
sanitized rows to `rowsEqual`/`enforceLayoutColSpans` as today.

---

## Tier 2: Design smells

### 2.1 `setWidgetColSpan`'s sibling rebalance writes an unvalidated id via bare bracket assignment

`src/applyMutation.ts` (~lines 757–764): on overflow with exactly one other row-mate,
`newSpans[otherIds[0]] = remaining` writes a key that is (a) never existence-checked
against `state.widgets` and (b) never passed through `isSafePatchKey` — the only
untrusted-key bracket _assignment_ in the file without that guard. Two consequences:

- On the fallback branch (target widget exists but sits in no row, so the wire-supplied
  `args.rowWidgetIds` is trusted), a phantom row-mate id gets a **persisted orphan span
  entry** — the exact dead weight the handler's own unknown-`widgetId` guard (prior fix
  "2.2") exists to prevent.
- `parseStateMutation` validates `rowWidgetIds` only as `string[]`, not per-entry
  `isSafeId`, so `'__proto__'`/`'constructor'` can reach this assignment over the wire.
  Today it is harmless only _incidentally_: the assigned value is a number, so the
  inherited `__proto__` setter silently ignores it (and `'constructor'` merely shadows).
  If this ever assigned an object, it would be a live pollution vector. The file's stated
  convention ("`isSafePatchKey` before the bracket assignment (matching every other
  handler…)") is not followed here.

Suggested: gate the rebalance target with `Object.hasOwn(state.widgets, otherIds[0]) &&
isSafePatchKey(otherIds[0])`, and/or add per-entry `isSafeId` on
`setWidgetColSpan.args.rowWidgetIds` at the wire boundary. (The derived-`currentRow` main
path is unaffected — row members are real ids by construction.)

### 2.2 `updateWidget.changes` wire validator misses `titleMode`/`subtitleMode`

`src/parseStateMutation.ts` (~lines 277–314). The validator's own comment says "`changes`
is a wholesale widget merge, so its per-field types must be checked", and it checks
`title`, `subtitle`, `sourceId`, `kind`, and `config` — but not `titleMode`/`subtitleMode`,
the only other `StudioWidget` fields. `changes: { titleMode: 42 }` passes the wire gate,
merges into the widget, and persists a junk value in a field the client's auto-title
logic branches on. Small, but it is a completeness gap against the validator's stated
intent, and the fix is two `isOptionalString`-style checks (or a stricter
`'auto' | 'manual' | undefined` check).

---

## Tier 3: Minor / cosmetic

### 3.1 `normalizeChartSeries` carries two dead conditions

`src/factories.ts` (~lines 204–210):

- In `if (series.seriesType === undefined && series.type === resolvedType)`, the second
  conjunct is tautological: when `seriesType` is `undefined`, `resolvedType` is
  `series.type ?? undefined`, so `series.type === resolvedType` always holds. The early
  return is really just `seriesType === undefined`.
- The final `resolvedType === undefined ? rest : …` branch is unreachable: control only
  gets past the early return when `seriesType !== undefined`, which makes
  `resolvedType = type ?? seriesType` defined.

Harmless (arguably defensive), but the tautology reads as if it guards something it
doesn't. Simplify or annotate.

### 3.2 `deserializeState` uses truthiness (not `Array.isArray`) to detect legacy `columns`/`ySeries`

`src/statePersistence.ts` (~lines 373–389). `if (!columns && !ySeries)`:

- An **empty array** (`columns: []`, the grid factory default) is truthy, so every such
  widget's config is needlessly rebuilt at load — reference churn only, no behavior
  change, but it defeats the "return the widget untouched … keeping reference stability
  for the common case" intent stated in the adjacent comment.
- A truthy non-array (`columns: "junk"` in a hand-corrupted persisted doc) throws
  `columns.map is not a function` — an unnamed crash below the fail-closed, named-field
  gate `migrateState`'s `findMissingRequiredField` provides at the top level. Deep config
  validation is explicitly out of scope for this package, so this is only worth an
  `Array.isArray` swap, which fixes both points in one line.

### 3.3 `ARCHITECTURE.md` overstates the reducer's no-op coverage

Two claims are contradicted by the code until Tier 1 findings 1.1/1.2 are fixed (whichever
way that resolution goes, doc and code should be re-aligned):

- "`the changes merge … tracks whether it actually changed a key (not just attempted
to)`" — it tracks attempts (see 1.1).
- "Every handler honors the reference-equality no-op contract … `applyBulkUpdate`
  (nothing removed, added, **updated**, or laid out differently)" — a value-identical or
  field-less `updatedWidgets` entry churns (see 1.2).

---

## Explicitly checked and found sound

For the record, the following were adversarially probed and are _not_ defects:

- **Prototype pollution**: every id-keyed insert/lookup on the wire path is rejected by
  `parseStateMutation` (`isSafeId`, `hasUnsafeOwnKeys`) and backstopped in the reducer
  (`isSafePatchKey`, `Object.hasOwn`); computed keys in object spreads
  (`{ ...widgets, [id]: w }`) define own properties and cannot re-prototype. The one
  convention hole is 2.1, which is not exploitable with numeric values.
- **Reducer purity/determinism**: no `Date`/random/I-O in any handler; `renameAIThread`
  takes producer-stamped `updatedAt`; `createMutationEnvelope`'s clock lives in the
  factory, outside the reducer.
- **Exhaustiveness locks**: `MUTATION_HANDLERS`/`MUTATION_ARG_VALIDATORS` mapped types,
  the runtime table-sync test, `AssertKeysCovered` on all 17 config-key tuples,
  `AssertChartTypesCovered`/`AssertAllChartTypesListed`, and the
  `Record<BuiltinStudioWidgetKind, …>` tables all check out; the derived
  `CHART_CONFIG_KEYS` union cannot drift from the per-family tuples.
- **Migration registry**: gap-in-registry hard-fails; `structuredClone` isolates the
  caller's object on the slow path; the fast path's same-reference return is documented
  and test-pinned; the `REGISTERED_MIGRATION_VERSIONS` completeness pin exists.
- **`applyBulkUpdate` same-id remove+re-add resolving to "keep the old widget"** is the
  documented re-delivery-over-replace trade-off, not a bug.
- **`GRID_COLS`/`MIN_SPAN` single-source claim** verified: `canvasGridConstants.ts` and
  `StudioController` in `@mui/x-studio` import them from this package.
- **`aiToolRegistry` "single source of truth" claim** verified against
  `@mui/x-studio-ai-middleware`: the MCP-only data tools (`compute_field_stats`, etc.)
  are a documented separate category in `mcp/toolMetadata.ts`, not registry drift.
- **`temporalUtils` offset fast-path**: the `+`/`-`-in-tail escape correctly routes
  offset-carrying datetimes through `new Date`; the documented non-goals (per-month
  calendar validity, garbage tails) are deliberate and test-pinned.
- **`serializeDoc` spread-based field carry** plus the round-trip key-set test genuinely
  prevents a forgotten new `StudioDoc` field.

## Finding counts

- Tier 1: **3**
- Tier 2: **2**
- Tier 3: **3**
