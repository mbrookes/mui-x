# x-studio-schema — Architecture Review (Iteration 8)

Fresh, ground-up review of `packages/x-studio-schema/src` cross-checked against
`ARCHITECTURE.md`. Every runtime module was read in full; findings below were each
reproduced end-to-end against the real package source (repro script output cited).

Result: **1 Tier 1, 3 Tier 2.** After seven hardening rounds the common cases are
solid; the four findings are all _interaction gaps between the recently-added
partial-payload / null-coercion fixes_ — places where one boundary was hardened but
a sibling path with the same hazard was left inconsistent. None is triggered by the
current shipping producers, but each is reachable via a validated-as-OK wire payload
or a documented "parser-bypassing server-built mutation" path the file otherwise
defends against everywhere.

---

## Tier 1

### T1-1 — `applyBulkUpdate` with **only `widgetColSpans`** present silently WIPES the active page's entire layout

**File:** `packages/x-studio-schema/src/applyMutation.ts:1187` (and the block 1199–1275)

**What's wrong.** This is the exact edge case the iteration-7 "finding 2.5" fix set
out to close, but it closed only two of the three partial-payload shapes. The gating
predicate is:

```ts
const hasLayoutUpdate = widgetRows !== undefined || widgetColSpans !== undefined;
```

- **both absent** → block skipped → layout preserved ✅ (tested, line 2226)
- **`widgetRows` present, `widgetColSpans` absent** → block runs, spans coerced to `{}` ✅ (tested, line 2262)
- **`widgetColSpans` present, `widgetRows` absent** → block runs, but `safeRows` falls to `[]`:

```ts
const safeRows = Array.isArray(widgetRows) ? widgetRows : [];   // → []  when widgetRows omitted
const sanitizedRows = dedupeLayoutRows(safeRows...);            // → []
...
widgetRows: sanitizedRows,                                       // installs [] over the real rows
```

So a bulk update that carries only a span change (`widgetColSpans: { w1: 18 }`, no
`widgetRows`) replaces the active page's `widgetRows` with `[]` — every widget is
un-placed from the page — and `enforceLayoutColSpans([], [], …)` then drops the span
too (orphaned against the now-empty rows). The page renders blank.

This is strictly the "defaulting an absent `widgetRows` to `[]` would silently WIPE
the active page's layout" failure the code's own comment (line 1181–1186) says it is
avoiding — but the avoidance only fires for the _both-absent_ case, not the
_spans-only_ case.

**Why it's Tier 1 (reachable at a trust boundary that passes validation).**
`parseStateMutation` was deliberately loosened (T2-4 parser half) to make
`widgetRows`/`widgetColSpans` independently optional, so it **accepts** a spans-only
bulk payload. Reproduced:

```
[B] spans-only bulk: rows after = []  spans after = undefined  widgets kept: w1,w2
[B] parser accepts spans-only bulk: true
```

The client's sole SSE trust boundary (`applyStateMutation` → `parseStateMutation` →
`applyMutation`) therefore lets a server-sent spans-only bulk through and wipes the
user's active-page layout. The only thing preventing it today is that the _current_
middleware producer always sends both fields together — but the client trusts any
server, and this is silent data loss, not a throw.

**Suggested fix.** Make the layout-replacement block total over _which_ field is
present, mirroring the both-absent skip: when `widgetRows` is absent but
`widgetColSpans` is present, do not synthesize empty rows — either (a) skip the
`widgetRows` replacement and apply only the span reconciliation against the page's
_existing_ rows, or (b) default `safeRows` to the page's current `widgetRows` rather
than `[]`. Add a regression test for the spans-only shape (the mirror of the
line-2262 rows-only test), which is the currently-missing third case.

---

## Tier 2

### T2-1 — `applyDocMutation` / `mutationLabel` dispatch via an un-guarded bracket lookup; a `type` naming an `Object.prototype` member is not a graceful no-op

**File:** `packages/x-studio-schema/src/applyMutation.ts:1456` and `:1478`

**What's wrong.** Both dispatchers look up the handler with a bare bracket read:

```ts
const handler = MUTATION_HANDLERS[mutation.type] as MutationHandler<...> | undefined;
return handler ? handler.apply(doc, mutation.args) : doc;   // applyDocMutation
return handler ? handler.label(mutation.args) : (mutation as {type:string}).type; // mutationLabel
```

`MUTATION_HANDLERS` has no null prototype, so a `mutation.type` that names an
`Object.prototype` member resolves up the prototype chain instead of to `undefined`,
defeating the `handler ? … : doc` guard. Every _other_ table lookup in this package
(the reducer's `Object.hasOwn(state.widgets, …)` guards, `parseStateMutation`'s
`Object.hasOwn(MUTATION_ARG_VALIDATORS, type)` at line 629, `getAllowedConfigKeys`'
`Object.hasOwn`) uses `Object.hasOwn` for exactly this reason — the two dispatch
sites are the inconsistent hold-outs. Reproduced against real source:

```
[A] applyDocMutation type=constructor === doc? false  result: {}
[A] mutationLabel type=constructor THREW: handler.label is not a function
[A] type=__proto__ THREW: handler.apply is not a function
[A] type=toString result typeof: string
```

Consequences per prototype member reached:

- `type: 'constructor'` → `handler` is the `Object` function; `handler.apply(doc, args)`
  invokes `Object.apply(doc, args)` and returns a bogus `{}`. The `applyMutation`
  wrapper then sees `{} !== state.doc` and commits `{ ...state, doc: {} }` — **the
  entire doc replaced by an empty object** (all pages/widgets/filters gone).
- `type: 'toString'` → returns the string `'[object Object]'` as the "next doc".
- `type: '__proto__'` / `'valueOf'` → `handler.apply` is `undefined` → throws mid-apply.
- `mutationLabel` with any of these → `handler.label` is not a function → throws.

The documented contract (ARCHITECTURE line 174; the code comment at 1449–1456
explicitly says it "guard[s] the lookup at runtime too" for "a value arriving over
the wire … not guaranteed to match") is that an unrecognized `type` is a **graceful
no-op / raw-type-string**, never a throw or a corrupt result. That contract is
violated for the prototype-member `type` strings.

**Why Tier 2 (not Tier 1).** On the shipping client path, `parseStateMutation` rejects
a prototype-member `type` (its `Object.hasOwn` table guard) before `applyMutation` is
called, and the server builds its own known-good types — so the primary wire path is
shielded. But `applyDocMutation`/`applyMutation`/`mutationLabel` are public exports
documented as safe over arbitrary/forward-incompatible `type`, and `mutationLabel`
in particular is not always preceded by the parser.

**Suggested fix.** Guard both lookups with `Object.hasOwn(MUTATION_HANDLERS, mutation.type)`
(or give the table a `null` prototype) before the `handler ?` check, matching the
`Object.hasOwn` discipline used everywhere else in the package.

---

### T2-2 — Reducer `addWidget` / `applyBulkUpdate.addedWidgets` install a `config: null` widget verbatim, leaving a landmine for the _next_ config-touching mutation

**File:** `packages/x-studio-schema/src/applyMutation.ts:602–617` (`addWidget`) and `:1318–1323` (`applyBulkUpdate.addedWidgets`)

**What's wrong.** The load boundary was hardened (iteration-7 "finding 2.4":
`deserializeState` coerces a non-record `config` to `{}` before installing a widget,
`statePersistence.ts:486`), and `normalizeConfigChartSeries` was made null-tolerant so
the _immediate_ add doesn't throw. But the reducer's add paths only guard the
immediate `normalizeConfigChartSeries` call — they then store the widget with its
`config` **still `null`**:

```ts
const normalizedConfig = normalizeConfigChartSeries(widget.config); // returns null unchanged
const normalizedWidget = normalizedConfig === widget.config ? widget : {...};
// widget stored with config: null
```

`config: null` renders "fine" until the next `updateWidget`/`applyBulkUpdate`
mutation touches that widget's config, where `shallowRecordEqual(existing.config, …)`
does `Object.keys(null)` and throws. Reproduced:

```
[C] widget installed with config = null
[C] updateWidget changes.config on null-config widget THREW: Cannot convert undefined or null to object
[C] bulk updatedWidgets config on null-config widget THREW: Cannot convert undefined or null to object
```

This is exactly the "server-built mutation that bypassed `parseStateMutation`" case
the file defends against everywhere else (the `config: null` guards in `updateWidget`'s
patch branch at 644, its `changes.config` branch at 718, and `normalizeConfigChartSeries`
itself at 186 all exist for this). The add path is the inconsistent hold-out: it
neutralizes the _immediate_ throw but persists the null that breaks a _later_ commit —
deferred rather than closed. The iteration-7 test only pins that the add itself doesn't
throw (line 132), not that the resulting widget is safe to update.

**Suggested fix.** Coerce a non-record `config` to `{}` when installing an added
widget, mirroring `deserializeState`'s finding-2.4 coercion — one line in `addWidget`
and in the `applyBulkUpdate.addedWidgets` loop. Add a regression test that adds a
null-config widget and then updates it.

---

### T2-3 — `deserializeState` validates `ai.threads` is an array but not that each thread ENTRY is a record; a null entry defers a throw to `renameAIThread`

**File:** `packages/x-studio-schema/src/statePersistence.ts:594–597` (load guard) and `applyMutation.ts:1410` (reducer read); also `findMissingRequiredField` `statePersistence.ts:181` (no `ai` check)

**What's wrong.** The `doc.ai` load guard keeps `ai` "only when it is a record whose
`threads` is an array" — but does **not** validate the array's _entries_:

```ts
ai: isRecord(serialized.ai) && Array.isArray((serialized.ai as StudioAIState).threads)
      ? serialized.ai : undefined,
```

So `ai: { threads: [null, {…}] }` loads verbatim. `renameAIThread` then does
`(state.ai.threads ?? []).map((t) => { if (t.id !== …` — `t.id` off `null` throws.
Reproduced:

```
[D] load kept ai? true
[D] renameAIThread over null thread entry THREW: Cannot read properties of null (reading 'id')
```

`serializeDoc` also re-persists the junk (`threads.length > 0` keeps the whole `ai`),
so it round-trips indefinitely, and `findMissingRequiredField` never inspects `ai` at
all — so a null thread entry passes migration AND deserialize and only surfaces as a
crash on the first rename.

This is inconsistent with the sibling `filters` treatment added in the same round:
`deserializeState` drops non-record `filters` entries (line 572–578) and
`findMissingRequiredField` rejects a non-record `filters[*]` (line 218–226). The
`threads` array got the container check but not the matching per-entry check.

**Suggested fix.** In the `ai` load guard, filter `threads` to record entries (drop
`null`/primitive entries) the same way `filters` are filtered, or reject the doc in
`findMissingRequiredField` with a named `ai.threads[i]` field. Add a regression test
with a null thread entry that loads and then renames without throwing.

---

## What was checked and found clean

- **Partition discipline** — `applyDocMutation` handlers are typed `StudioDoc`, so
  `session`/`runtime` are structurally unreachable; the `applyMutation` wrapper's
  reference-equality no-op contract (returns same `state` when doc unchanged) holds.
  No handler touches `session`/`runtime`. ✅
- **Reference-equality no-op contract** — verified for every handler
  (`setActivePage`, `setDashboardTitle`, `renamePage`, `setWidgetColSpan`/`setWidgetLayout`
  via `rowsEqual`/`spansEqual`, `updateWidget`'s three change-tracking branches,
  `applyBulkUpdate`'s `widgetsChanged`+`nextPages`+`nextFilters` gate, `renameAIThread`).
  The `shallowRecordEqual`/`spansEqual` sharing is correct. ✅
- **Prototype-hazard key discipline** at the _record-write_ sites — `addPage`,
  `addWidget`, `updateWidget` (config/changes/unsetConfigKeys), `setWidgetColSpan`'s
  sibling-rebalance, `applyBulkUpdate`'s span rebuild + added-widget inserts,
  `normalizePersistedPages`, `deserializeState`'s widget-key screen, `removeWidgetIds`'
  `Object.fromEntries` rebuild — all correctly guarded. (T2-1 is the _dispatch_-lookup
  hold-out, a different site.) ✅
- **id↔key reconciliation** (finding 2.1) — widget (`deserializeState:483`) and page
  (`normalizePersistedPages:398`) re-stamp `id` to the record key; interacts correctly
  with the null-config coercion (both run on the same surviving widget before
  leaf-normalization). The prompt's "both conditions true on the same widget" case was
  checked: `deserializeState` applies the `id` re-stamp and the `config:{}` coercion
  independently on `base`, so a widget with both a desynced id AND null config is
  handled correctly. ✅
- **Migration fail-closed logic** — `NaN`/fractional `schemaVersion` rejection,
  registry-gap hard failure, `structuredClone` try/catch, newer-than-current refusal,
  post-migration `findMissingRequiredField`. All correct. ✅
- **`setWidgetColSpan` finding-2.5 fallback** (`?? [widgetId]`), overflow rebalance,
  clamp/NaN guard, orphan-span guard, cross-page no-op — all correct.
- **`enforceLayoutColSpans` / `dedupeLayoutRows`** invariants, `removeWidget`'s
  scoped sole-occupant collapse, `removePage`/`removeWidgetIds` cross-page guard,
  filter-scope cleanup — all correct.
- **Config-key validation symmetry** (finding 2.2/2.3) — the three update-shaped
  channels get the `chartType`-membership check; the full-widget create path gets the
  family-key check with the `'bar'` fallback. `stripForeignFamilyKeys` exists for the
  stateless-round-trip case. Symmetric and correct. ✅
- **`temporalUtils`, `anomalyDetection`, `factories` id scheme + `normalizeChartSeries`
  nullish-alias handling, `unsafeKeys`, `widgetTypeGuards`, `aiToolRegistry`** — read
  in full, no issues.
- **ARCHITECTURE.md accuracy** — the doc's description of the finding-2.5
  layout-omission behavior (line 195: "leaving the active page's layout untouched …
  when `widgetRows` and `widgetColSpans` are BOTH absent") is accurate for the
  both-absent case but _does not disclose_ that a spans-only payload still wipes the
  layout (T1-1). The doc reads as if all partial shapes are safe; they are not. Update
  the doc alongside the T1-1 fix.

---

_Repro script: `scratchpad/iter8-repro.ts` (run with `./node_modules/.bin/tsx`), imports the real
`applyMutation.ts` / `parseStateMutation.ts` / `statePersistence.ts` sources — outputs cited inline above._
