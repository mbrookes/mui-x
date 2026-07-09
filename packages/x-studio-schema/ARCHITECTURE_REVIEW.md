# Architecture review — `@mui/x-studio-schema` (2026-07-09)

Fresh read of every file in `src/` (source + tests, ~10,200 lines) plus targeted
verification in the two consumers (`@mui/x-studio`'s SSE handler / `StudioCanvas` /
`filterUtils`, `@mui/x-studio-ai-middleware`'s `executeToolOnState`). This package has
been through three prior review-and-fix rounds and it shows: the mutation reducer, wire
validator, key allow-lists, and persistence boundary are mutually consistent, the
prototype-pollution surface is closed at both the wire boundary and the reducer
(verified guard-by-guard against every bracket assignment in `applyMutation.ts`), and
the test suites pin essentially every documented invariant, including the
reference-equality no-op contract per handler.

Findings below are ordered by severity within each tier. Anything I could not attach a
concrete failure scenario to was dropped.

---

## Tier 1 — correctness/security bugs with a clear reproduction path

**None found.**

What was specifically probed and came back clean:

- Every `record[key] = value` / `delete record[key]` site in `applyMutation.ts` is
  either gated by `isSafePatchKey`/`Object.hasOwn` or uses object-literal computed keys
  / `Object.fromEntries` (which create own properties and cannot pollute). The
  `parseStateMutation` `isSafeId`/`hasUnsafeOwnKeys` coverage matches the reducer's
  write sites one-for-one, including the `setWidgetColSpan.rowWidgetIds` fallback path.
- Reducer/validator/type triple-checked per variant: every `StateMutation` field the
  reducer keys or iterates on is shape-checked by `MUTATION_ARG_VALIDATORS`; the two
  mapped-type tables cannot drift and the runtime table-sync test pins it.
- `serializeDoc`'s spread-plus-strip cannot drop a new `StudioDoc` field, and the
  key-set round-trip test enforces it. `migrateState` is fail-closed on newer versions,
  registry gaps, and missing required fields; non-integer/negative `schemaVersion`
  values fall into the registry-gap hard failure rather than a silent stamp.
- `deserializeState`'s legacy normalization (`columns`/`ySeries`) is total over junk
  values and reference-stable for factory defaults.
- `applyBulkUpdate`'s delta semantics were adversarially walked (removed id still in
  the supplied rows → removal correctly cancelled by the `stillReferenced` guard, never
  a dangling row; re-delivered envelopes are no-ops; cross-page id collisions
  preserved).

---

## Tier 2 — real but lower-severity issues

### 2.1 Layout rows are sanitized for phantom ids but not for **duplicate** ids

- **Where:** `applyMutation.ts:729-731` (`setWidgetLayout` sanitization) and
  `applyMutation.ts:1007-1009` (`applyBulkUpdate` row sanitization);
  `parseStateMutation.ts:381-389` / `:488-490` only check `string[][]` shape.
- **Mechanism:** `setWidgetLayout` drops row entries whose id is not in
  `state.widgets`, but the same id appearing **twice** (in one row or across rows)
  passes the parser, the reducer, and the middleware's `set_widget_layout` membership
  check (`executeToolOnState.ts:592-605` validates unknown ids, not uniqueness). The
  duplicated layout is installed and persists through `serializeDoc`.
- **Trigger:** an LLM `set_widget_layout` tool call listing a widget id twice — a
  realistic model mistake nothing in the chain currently rejects — or any malformed
  SSE payload.
- **Consequence:** the page renders the same widget twice; `StudioCanvas` keys widgets
  by id (`packages/x-studio/src/components/StudioCanvas/StudioCanvas.tsx:369`,
  `<React.Fragment key={widgetId}>` inside `row.map`), so a within-row duplicate is a
  duplicate React key (dropped/misrendered element, console error). A within-row
  duplicate also double-counts the widget's span in `enforceLayoutColSpans`'s overflow
  sum (`applyMutation.ts:268-274`): `[['w1','w1']]` with `w1: 13` sums to 26 > 24 and
  **deletes a valid span**. The corrupt layout round-trips to disk.
- **Fix shape:** dedupe ids (first occurrence wins) during the existing sanitization
  passes in `setWidgetLayout`/`applyBulkUpdate` — the same choke points the
  phantom-id guard already uses.

### 2.2 `addFilter` leaves `filter.field`/`filter.operator` completely unvalidated at the wire boundary

- **Where:** `parseStateMutation.ts:252-260` (`validateFilter` checks only `id` +
  `scope`); type contract in `stateTypes.ts:55-107` requires `field: string`,
  `operator: StudioFilterOperator`.
- **Mechanism:** the parser's documented rule is "check what other code keys/iterates
  on", and `field`/`operator` **are** read downstream: `mutationLabel` interpolates
  `args.filter.field` (`applyMutation.ts:966`), the client pipeline branches on them
  (`packages/x-studio/src/internals/filterUtils.ts:375-388` — `isFilterComplete` only
  guards falsy `field`, so a truthy junk value like `field: 42` or `field: {}` counts
  as a complete filter), and `queryDescriptor.ts` forwards them to the data middleware.
  A payload `{ type: 'addFilter', args: { filter: { id: 'f1', field: 42, operator: {},
value: 1, scope: { kind: 'page' } } } }` passes the gate, is appended verbatim, and
  persists to disk.
- **Trigger:** malformed/hostile SSE payload (the exact threat `parseStateMutation`
  exists for — the server-side producers do validate operators, but the client must
  not rely on that).
- **Consequence:** an active-but-unevaluable filter: `row[42]`/unknown-operator
  comparisons match nothing, so every widget in scope silently renders empty until the
  user finds and deletes the chip; the mutation log shows `addFilter:undefined`-style
  labels. Prior review rounds closed the exactly-analogous gaps for
  `changes.titleMode: 42` and full-widget scalars — this is the same class, one
  validator over.
- **Fix shape:** in `validateFilter`, require `isString(filter.field)` and
  `isString(filter.operator)` (an operator-membership check against a
  `StudioFilterOperator` list would be stronger but adds a maintained list; the
  string checks alone close the concrete failure).

### 2.3 `setWidgetColSpan` can persist an orphan span on a page the widget is not on

- **Where:** `applyMutation.ts:775-798` — the unknown-widget guard checks
  `Object.hasOwn(state.widgets, widgetId)` (global existence), then writes
  `newSpans[widgetId]` into `targetPage.widgetColSpans` without checking that the
  widget is in **that page's** rows; `enforceLayoutColSpans` does not run in this
  handler.
- **Mechanism/trigger:** the widget exists but lives on a different page than the
  resolved target — either a legacy payload without `pageId` applied while the user is
  on another page, or an explicit server-stamped `pageId` racing a concurrent user
  move of the widget to another page mid-turn (the same concurrency class the
  `currentRow`-derivation comment in this handler names). `currentRow` is `undefined`,
  the fallback `args.rowWidgetIds` is used, and the span lands in the wrong page's map.
- **Consequence:** a dead `widgetColSpans` entry that serializes to disk (exactly what
  the handler's own unknown-id guard exists to prevent, per its comment) and — worse —
  if the widget is later moved (back) onto that page into a shared row, the stale span
  silently applies to the new row arrangement. Self-limiting (any later layout
  mutation on that page prunes it as an orphan), which is why this is Tier 2, not 1.
- **Fix shape:** when `currentRow` is `undefined` on the target page, either no-op or
  run the resulting map through the orphan-drop half of `enforceLayoutColSpans`.

---

## Tier 3 — architectural/cohesion debt worth addressing eventually

### 3.1 `migrateState` can throw instead of returning a failed `MigrationResult`

`statePersistence.ts:247` calls `structuredClone(state)` outside any try/catch. The
documented contract ("Persisted state is JSON") makes this safe for real persisted
input, but `migrateState(state: unknown)` is a public API whose every other failure
mode returns `{ success: false, errors }`; a caller that mistakenly passes a live
object containing a function (e.g. a state with a `dataSources.adapter` attached)
gets an uncaught `DataCloneError` on the migration path only (the already-current fast
path never clones, so the failure is version-dependent and confusing). One `try`
around the clone would make the function total, matching its own error style.

### 3.2 Reducer invariants are write-side only; the load boundary re-checks nothing

`deserializeState` (`statePersistence.ts:352-419`) normalizes two legacy leaf shapes
but installs `pages` verbatim: a corrupted or hand-edited persisted doc with phantom
`widgetRows` ids (no `widgets` entry) or out-of-range `widgetColSpans` (e.g. `3` or
`40`) loads as-is — blank cards / wrong widths render until the next layout mutation
happens to pass through `enforceLayoutColSpans` or the row sanitizers. Every _live_
path maintains the invariants, so this only bites corrupted input, and "deep config
validation is out of scope" is a documented stance — but layout ids/spans are the same
class of key/number the reducer already guards, so a cheap load-time sweep (filter
rows against `widgets`, clamp spans) would close the residual gap without becoming a
deep validator.

### 3.3 Small duplications

- `spansEqual` and `shallowRecordEqual` (`applyMutation.ts:100-146`) are the same
  key-count + per-key `===` loop; `spansEqual` is just the `undefined`-tolerant
  wrapper. One generic helper with the wrapper would remove the risk of the two
  drifting (e.g. one gaining a tolerance the other lacks).
- The five id factories (`factories.ts:33-86`) are five hand-copies of the same
  4-line timestamp+counter+random pattern, each with its own module-level counter. A
  `makeIdFactory(prefix)` would collapse them; today a tweak to the scheme must be
  applied five times (the doc comments already cross-reference `createWidgetId` for
  the rationale, acknowledging the duplication).

Neither is urgent; both are contained within single files with full test coverage.

---

## Overall assessment

The package is in genuinely good shape. The three-tier state partition, the
handler/validator mapped-type exhaustiveness locks, the single shared unsafe-key
denylist, and the compile-time key-list assertions in `configKeyValidation.ts` mean
the usual drift failure modes (validator vs. reducer, kind-level vs. chart-level
allow-lists, serializer vs. doc shape) are structurally prevented, not just tested.
No Tier 1 issues were found. The Tier 2 items are all "the existing guard stops one
step short of the adjacent case" gaps — each has an obvious home inside an existing
sanitization choke point.
