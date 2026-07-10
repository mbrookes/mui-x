# Architecture review — iteration 10 (`@mui/x-studio-ai-middleware`)

Scope: full re-read of `ARCHITECTURE.md` and every file under `src/` (all 28 non-test modules), plus the
relevant `@mui/x-studio-schema` sources (`applyMutation.ts`, `factories.ts`, `configKeyValidation.ts`)
where executor behavior depends on reducer behavior. Per the round-10 methodology directive, the two
recurring bug classes (prompt-injection interpolation sites; authorization-parity on read surfaces) were
re-derived **independently and exhaustively** — every site is enumerated below with a verdict, not
spot-checked — and every new finding was itself swept package-wide for sibling sites of the same shape
before write-up.

**Summary: 0 Tier 1 findings, 4 Tier 2 findings (plus 1 borderline Tier 2 noted at lower confidence).**
The prompt-injection invariant (invariant 13) was independently re-verified across every interpolation
site in the package: **no sixth instance exists** — iteration 9's claim holds. The Tier 2 findings are in
two of the _other_ recurring classes: a prototype-member-key existence-check gap replicated across the
tool executor (the exact shape iter9's T2-4 fixed in one file only), an authorization-parity gap on the
one MCP read surface never gated (`prompts/get`), and two value-shape gaps of the iter9 T2-3 class.

---

## Part A — Independent re-derivation of invariant 13 (prompt-injection sweep)

Method: every site in the package where a state-derived, DB-derived, client-asserted, or LLM-derived
string reaches (a) prompt/message text, (b) MCP tool/resource/prompt _metadata_, (c) rendered SVG, or
(d) an error string returned to an LLM-adjacent consumer, was located by reading every file in full and
grepping for template interpolation. Full inventory and verdicts:

| #   | Site                                                                                                                                                                                                                                                                                                                  | Verdict                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `buildAISystemPrompt.ts` — `describeWidget` (all widget kinds, all chart families)                                                                                                                                                                                                                                    | ✅ Structural: every value routed through `pushField`/`pushQuoted` → `sanitizeForPrompt`. Composites (`ySeries`, `forecast`, `funnel*` joins, grid `columns`, `source` label/id pair) are sanitized as a whole.                             |
| 2   | `buildAISystemPrompt.ts` — `describeSource`, `serializeFieldForAI` (labels, ids, distinct values, `aiDescription`)                                                                                                                                                                                                    | ✅ All through `sanitizeForPrompt`.                                                                                                                                                                                                         |
| 3   | `buildAISystemPrompt.ts` — `buildDashboardState` (dashboard title, mode, page titles/ids, layout row descriptions incl. client-asserted `widgetColSpans`, filter id/field/operator/`JSON.stringify(value)`, other-page widget titles, custom-widget kind/label/description/config keys, focused-widget title/id/kind) | ✅ All sanitized, including the `number`-typed span suffix.                                                                                                                                                                                 |
| 4   | `buildAISystemPrompt.ts` — `buildRichContextBlock` (`fieldStats` incl. number-typed stats, `pageLayout` incl. number-typed `colSpan`, `recentMutations` labels, `omitted`, `rowCounts` keys+values, `schemaComments`, `notes`)                                                                                        | ✅ All sanitized, number-typed fields included.                                                                                                                                                                                             |
| 5   | `buildAISystemPrompt.ts` — `buildSkillSection` (`name`/`mode` sanitized; `promptFragment` deliberately unsanitized prose + `neutralizeSkillBoundary`)                                                                                                                                                                 | ✅ Matches documented design (invariant 10 + tag-boundary defense). A `"`-in-name attribute spoof inside the `<skill …>` open tag cannot escape the tag (`<`/`>` escaped) and is moot since the adjacent fragment is already trusted prose. |
| 6   | `generateFieldDescriptions.ts` (ids, labels, types, live `sampleValues`, `sourceLabel`)                                                                                                                                                                                                                               | ✅ Sanitized + 100-char cap + tagged `<fields>` region. The unparseable-JSON error (line 166) echoes raw LLM output into a host-thrown `Error` — host-consumed, not LLM-consumed; fine.                                                     |
| 7   | `handleGenerateInsight.ts` — `handleCreateWidget` source/field catalogue                                                                                                                                                                                                                                              | ✅ Sanitized + tagged `<data_sources>` region. `handleGenerateTitle` output shape-validated + capped (`normalizeGeneratedTitle`).                                                                                                           |
| 8   | `mcp/prompts.ts` — `prompts/get` example blocks (source/field labels/ids, `defaultAggregationFn`) and the unknown-`sourceId` error incl. the "Available:" catalogue                                                                                                                                                   | ✅ All through `sanitizeForPrompt` (T2-5 fix present at lines 74–75).                                                                                                                                                                       |
| 9   | `mcp/resources.ts` — `resources/list` per-source `name`/`description`                                                                                                                                                                                                                                                 | ✅ Sanitized (lines 154–159, 168–174); `uri` deliberately raw (addressable identifier).                                                                                                                                                     |
| 10  | `mcp/resources.ts` / `mcp.ts` errors echoing a single client-supplied identifier (`Unknown data source: "${sourceId}"` at resources.ts:387/446, `Unknown resource URI` at :470, subscribe errors at :482/:492, `Unknown tool: ${toolName}`)                                                                           | ✅ Accepted single-identifier round-trip carve-out established in iter9 (only the _catalogue-echoing_ error in `prompts.ts` needed sanitizing, and it is).                                                                                  |
| 11  | MCP tool titles/descriptions/annotations (`studioAITools.ts`, `mcp/toolMetadata.ts`, `widgetConfigMeta.ts`), `prompts/list`, static resource entries                                                                                                                                                                  | ✅ Verified static — zero `${…}` interpolation in these files.                                                                                                                                                                              |
| 12  | `completion/complete` values (raw source ids)                                                                                                                                                                                                                                                                         | ✅ Addressable identifiers the client feeds back verbatim; same carve-out as `uri`.                                                                                                                                                         |
| 13  | `chartRenderer.ts` — every renderer (`bar`/`line`/`pie`/`scatter`/`donut`/`stacked_bar`)                                                                                                                                                                                                                              | ✅ `sanitizeInput` choke point (dimensions, hex-validated colors, coerced values/text) + `esc()` on every text-content position, including the donut center total. No attribute position receives an unvalidated string.                    |
| 14  | Tool outputs / tool-result errors (executor `{error}` strings, `skipped` arrays, data-tool JSON payloads)                                                                                                                                                                                                             | ✅ JSON-framed tool output is the established data-region convention on both transports (same as `get_dashboard_state`'s raw JSON), consistent with all prior rounds.                                                                       |
| 15  | `agenticLoop/openaiWire.ts`, `parseSSE.ts`, `buildPageLayoutContext.ts`, `mcp/helpers.ts`, `mcp/types.ts`, `models/*`, `index.ts`, `studioSkills.ts`                                                                                                                                                                  | ✅ No LLM-consumed text assembly (layout context is rendered — sanitized — in `buildRichContextBlock`).                                                                                                                                     |

**Conclusion: invariant 13 holds at every entry point that exists today. No sixth instance.** This is an
independent re-derivation, not a restatement of iteration 9.

---

## Part B — Authorization-parity sweep (every read surface vs. its gate)

| Surface                                                                                 | Gate                                                                                                                          | Verdict             |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| MCP `tools/call` (all names)                                                            | `isToolAllowed` → dispatch-table args-only consult / mutation-path `executeToolWithPolicy`                                    | ✅                  |
| `studio://dashboard/state`, `studio://dashboard/system-prompt`, `studio://schema/{id}`  | `authorizeResourceStateAccess` (mapped onto `get_dashboard_state`)                                                            | ✅                  |
| `studio://data/{id}`, `studio://dashboard/data-health`, system-prompt `contextEnricher` | `authorizeResourceDataAccess` (mapped onto `query_data_source`, `sourceId` threaded for the per-source read)                  | ✅                  |
| `resources/list`, `prompts/list`, `completion/complete`                                 | Ungated listing surfaces (by documented design; expose source ids/labels only)                                                | ✅ per design       |
| `resources/subscribe`                                                                   | URI-shape check + cap; returns no content                                                                                     | ✅                  |
| **`prompts/get` (`query_data_source_examples`)**                                        | **No gate at all**                                                                                                            | ❌ **Finding T2-2** |
| Chat dispatch                                                                           | advertisement filter + T1-1 `advertisedToolNames` gate + policy chokepoints                                                   | ✅                  |
| `privateMode`                                                                           | `PRIVATE_MODE_EXCLUDED_TOOLS` unadvertised **and** dispatch-rejected; `contextEnricher`/richContext/state blocks all withheld | ✅                  |

---

## Findings

### Tier 1

**None.**

### T2-1 — Prototype-member entity ids pass the executor's truthy existence checks; reducer no-ops make the tool lie `success: true` (multi-site; one site commits real junk state)

The shared reducer (`@mui/x-studio-schema/src/applyMutation.ts`) is fully `Object.hasOwn`-hardened
(lines 551, 602, 651, 827, 901, 956, 962, 1067, 1088, 1145, …): an id like `"constructor"`,
`"toString"`, or `"__proto__"` silently no-ops there. Iteration 9's T2-4 fixed the _same lookup shape_
in `mcp/resources.ts`'s schema branch with `Object.hasOwn` — but the tool executor, which performs the
same bracket lookups on the same plain objects with model-supplied keys, was never swept. A bare
`state.doc.widgets[widgetId]` / `state.doc.pages[pageId]` resolves a prototype-member key to a truthy
function via the prototype chain, so the executor's "validate-then-mutate" existence checks pass, a
mutation is built and "committed" (SSE event emitted / `recentChanges` logged / `committedMutations`
incremented / MCP `onStateChange` persistence hook run), the reducer no-ops on both server and client,
and the model is told `success: true` for a call that changed nothing — the exact desync class the
existence checks were added to prevent (and, for `set_widget_width`, the exact
`{ success: true, columns: null }` bug its active-page check was documented as closing).

Affected sites in `src/executeToolOnState.ts` (all bare truthy lookups with a model-supplied key):

- **`update_widget` — line 536** (`const widget = state.doc.widgets[widgetId]`). Bonus wrongness: `widget.kind` is `undefined`, so kind-level config validation runs with an unknown kind (unrestricted → passes) and `{ ...widget.config }` spreads `undefined`; reducer no-ops (applyMutation.ts:651); output `success: true`.
- **`remove_widget` — line 633.** Passes the check, requires approval (name-destructive), human approves a no-op, `success: true` reported.
- **`set_widget_layout` — line 705** (membership check `!state.doc.widgets[id]`). A phantom `"constructor"` cell is accepted; the reducer's row filter (applyMutation.ts:917, `Object.hasOwn`) silently drops it, so the committed layout differs from the `{ success: true, rows }` the model was shown.
- **`set_widget_width` — line 742.** Not in any page's rows → permissive fallback → `setWidgetColSpan` mutation → reducer orphan guard no-ops (applyMutation.ts:962) → reads back `null` → reports `{ success: true, widgetId, columns: null }`.
- **`rename_page` — line 801, `remove_page` — line 818, `set_active_page` — line 840** (`state.doc.pages[pageId]`). Reducer hasOwn guards (applyMutation.ts:1067/1088/1145 area) no-op; `success: true` reported; for `set_active_page` subsequent same-turn tools still operate on the old active page while the model believes it switched.
- **`add_widget_filter` — line 902.** The worst one: the `addFilter` reducer applies the filter **verbatim** (applyMutation.ts:1162–1176, no widget-existence validation by design), so this is not a no-op — a dangling filter scoped to `{ kind: 'widget', widgetId: 'constructor' }` is _really committed_ on server **and** client and persisted with the document. The existence check this tool was given (per the ARCHITECTURE.md "validate-then-mutate" contract) is fully bypassed by a prototype key.

Same-shape sites that currently fail safe **by accident** (harden for consistency in the same pass):

- `executeToolOnState.ts:1391` (`set_widget_forecast`) — saved by `isWidgetOfKind` returning false.
- `mcp/queryTools.ts:55` (`resolveSource`) and `mcp/resources.ts:443` (`studio://data/` branch) — saved only by the `!source.tableName` check (no prototype member has a `tableName`).
- `mcp/summarisePage.ts:55` (`state.doc.pages[resolvedPageId]`) — resolves to a truthy function, then degrades to "No queryable widgets found on page \"constructor\"".
- `buildAISystemPrompt.ts:687` (`focusedWidgetId` lookup) — renders a sanitized `"undefined"` title; cosmetic.
- `agenticLoop/toolDispatch.ts:147/151/165` (`buildApprovalDisplayInput`) — display-only `?.title` reads; benign but same shape.

**Concrete failure scenario:** a prompt-injected (or merely hallucinating) model calls
`add_widget_filter({ widgetId: "constructor", field: "x", sourceId: "s", operator: "equals" })` →
committed junk filter persisted into the dashboard document; or `set_active_page({ pageId: "__proto__" })`
→ `success: true`, model plans the rest of the turn against a page switch that never happened, mutation
budget and `recentChanges` polluted with phantom entries.

**Fix direction / invariant:** _every_ model-supplied entity id must be resolved with
`Object.hasOwn(map, id)` before the bracket read — the exact discipline the reducer already documents
and enforces, and that iter9 applied to `resources.ts`. Cleanest fix: two tiny local helpers in
`executeToolOnState.ts` (`getWidget(state, id)` / `getPage(state, id)` returning
`Object.hasOwn(...) ? map[id] : undefined`) used by every site above, so the next tool added can't
reintroduce the shape. This is the fifth recurrence of a "fix applied only at the reported site" class —
the helper, not another spot fix, is the point.

### T2-2 — `prompts/get` is the one MCP content-read surface that bypasses the `allowedTools`/`toolPolicy` chokepoint

`mcp/prompts.ts` (`registerPromptHandlers`, wired at `mcp.ts:623`) receives **only** `{ stateBox }` —
no `authorizeStateAccess`/`authorizeDataAccess`, no `isToolAllowed`. The
`query_data_source_examples` prompt (prompts.ts:52–189) is not a listing: it serves a per-source
**schema slice** — source ids/labels, the first categorical and first numeric field's id and label, and
`defaultAggregationFn`, for every non-hidden queryable source — i.e. a strict subset of the
`get_dashboard_state` / `describe_data_source` payloads whose resource-read equivalents were all gated
in iterations 7–9 (findings 2.1, T2-1). A host that excludes `get_dashboard_state` and every data tool
via `allowedTools` (or denies them via `toolPolicy`) still leaks a partial schema catalogue through
`prompts/get`, and the consult never increments `sessionUsage.toolCalls`, so a usage-aware policy
undercounts these reads — the same two parity properties the resource gates were built to restore.

It does **not** expose row-derived data (`fieldDistinctValues` are never read here), which is why this
is Tier 2 severity rather than the T2-1-of-iter9 severity, but it is the same bug shape: a read surface
serving a tool-equivalent payload without the tool's gate. This is also precisely the category the
ARCHITECTURE.md invariant-13 postscript predicted ("a new MCP prompt … added without going through" the
established patterns) — the gate pattern was applied to `resources/*` but never to `prompts/*`.

**Concrete failure scenario:** MCP session created with `allowedTools: []` (host intends a fully locked
surface — the documented meaning: "disables even always-present tools"). Client calls
`prompts/get({ name: 'query_data_source_examples' })` and receives every source's id, label, and two
field ids/labels per source.

**Fix direction / invariant:** every non-listing MCP read surface that serves state-derived content must
run the authorization gate of the tool whose payload it (partially) exposes. Thread
`authorizeStateAccess` (mapped onto `get_dashboard_state`, exactly like `studio://schema/{id}`) into
`registerPromptHandlers` and run it at the top of the `query_data_source_examples` branch; leave
`prompts/list` and `completion/complete` ungated as listing surfaces (parity with `resources/list`,
ungated by documented design).

### T2-3 — `fieldType` is trusted at its declared enum type in both filter-creating tools (same class as iter9's forecast `enabled: "false"` fix)

`src/executeToolOnState.ts:871` (`add_page_filter`) and `:917` (`add_widget_filter`):

```ts
const fieldType = args.fieldType as StudioDataField['type'] | undefined;
```

The tool schema (studioAITools.ts:269–273, :324–327) _describes_ `fieldType` as one of
`string | number | date | datetime | boolean`, but the executor stores the raw value via a bare cast —
no membership check, not even `typeof === 'string'`. This is exactly the value-shape class iter9's T2-3
closed for `set_widget_forecast` (`enabled`/`showConfidenceBands`) and finding 3.2 closed for scalar
config values: a schema-declared type trusted instead of validated. Notably the very same tools already
validate their `operator` argument against an exhaustive runtime allow-list
(`VALID_FILTER_OPERATORS`, `satisfies Record<StudioFilterOperator, true>`) — `fieldType` is the one
argument in these two tools left out of that discipline.

**Concrete failure scenario:** `add_page_filter({ …, fieldType: "text" })` (a classic LLM slip) or a
crafted `fieldType: { $x: 1 }` persists verbatim into `StudioFilterState.fieldType` — a field typed
`StudioDataField['type']` — with `success: true`. The client filter UI keys its input rendering off this
value ("Helps the UI render the correct filter input"), so a broken filter editor ships with the
persisted document.

**Fix direction / invariant:** untrusted enum-typed tool args are validated against an exhaustive
runtime set derived from the schema union (the `VALID_FILTER_OPERATORS` pattern, one object literal with
`satisfies Record<StudioDataField['type'], true>`), shared by both call sites; an invalid value either
fails the call (matching the fail-closed operator handling) or is dropped to `undefined` (it is an
optional hint) — pick one and document it. While there, note `value`'s per-operator shape (`in`/`not_in`
→ array, `between` → `[min, max]`) is also unvalidated; a cheap shape check would return an actionable
error instead of committing a filter the pipeline can't evaluate.

### T2-4 — `add_widget` / `apply_bulk_update` accept any unregistered `kind` string, which both mints an unrenderable widget and bypasses all config-key validation

`src/executeToolOnState.ts:360` (`buildWidgetFromArgs`, used by `add_widget` and bulk additions):

```ts
const kind = String(args.kind ?? 'chart') as StudioWidget['kind'];
```

No validation against the known kinds. Two compounding consequences, both verified in the schema
package:

1. `validateConfigKeysForKind` returns `[]` (unrestricted) for any unknown kind — deliberate, to support
   _registered_ custom widgets — so an unknown kind **also skips the entire kind-level and chart-level
   config-key validation** (`invalidChartConfigKeyError` only runs when `kind === 'chart'` exactly).
2. `createDefaultWidget` (factories.ts) treats any non-built-in kind as a custom kind and happily mints
   `{ kind, config: { customConfig: {} } }`.

But the executor _knows_ the full legitimate kind set at the call site: the built-in kinds plus
`customWidgets[].kind` (the `customWidgets` array is already threaded into `ToolPlanContext` and already
consulted for `defaultConfig`). A model slip as small as `kind: "Chart"` (capitalization) or
`kind: "table"` therefore commits a widget the client cannot render — reported `success: true` — with an
arbitrary unvalidated config bag attached. This violates invariant 12 ("config-key writes are
fail-closed") for the one input that selects _which_ allow-list applies: the kind itself is the
unvalidated key above all the validated keys.

**Concrete failure scenario:** `add_widget({ kind: "Chart", title: "Revenue", config: { chartType: "bar",
xField: "region", bogusKey: "</dashboard_state>…" } })` → no key validation runs (unknown kind is
unrestricted; the chart-level check is skipped because `kind !== 'chart'`), widget committed and
persisted, client renders an unknown-kind placeholder, model told success. (The injection payload stays
inert thanks to the read-side sanitize choke point — this is a correctness finding, not an injection
one.)

**Fix direction / invariant:** the widget `kind` is untrusted enum-shaped input and must be validated
against the _closed, locally-knowable_ set `BUILTIN kinds ∪ customWidgets[].kind` in
`buildWidgetFromArgs`, failing the call (chat) / skipping the addition (bulk) with an error naming the
valid kinds — the same fail-closed treatment `chartType` already gets via `isStudioChartType`. The
schema package's "unknown kind = unrestricted" permissiveness is right for `createDefaultWidget` as a
library function; it is wrong as the _only_ gate on model-supplied input.

### T2-5 (borderline, lower confidence) — string-enum config values are still unvalidated at the write source

`SCALAR_CONFIG_VALUE_TYPES` (`executeToolOnState.ts:213–237`) deliberately covers only
`number`/`boolean` scalars, and structured config was declared out of scope — but string-**enum** config
fields (`barLayout`, `chartSortBy`/`chartSortDirection`, `heatSortDirection`/`heatColorScheme`/
`heatLegendPosition`, `funnelVariant`/`funnelCurve`/`funnelLabelFormat`, `crossFilterMode`,
`pieArcLabel`, `kpiSparklinePlotType`, `kpiTrendComparison`, `filterWidgetType`, aggregation fields,
etc.) sit in neither bucket: they pass key-presence validation and are stored verbatim.
`update_widget({ config: { barLayout: "diagonal" } })` or `{ crossFilterMode: "yes" }` commits an
invalid enum value into a union-typed field with `success: true`; client behavior is whatever each
renderer's fallback happens to be. Same class as T2-3 above and iter9's T2-3, but the surface is wide
and each value is individually low-stakes, hence borderline. **Fix direction:** extend the value-shape
table to a third category (`enum: readonly string[]`) populated from the schema unions (kept exhaustive
with `satisfies` the way `VALID_FILTER_OPERATORS` is), shared by the same three call sites
(`buildWidgetFromArgs`, `update_widget`, bulk updates). If deliberately deferred, document the scope
decision in ARCHITECTURE.md's finding-3.2 paragraph so the next round doesn't re-derive it.

---

## Explicitly checked and found sound (selected)

- **Iter9 fixes verified in current source:** forecast boolean strictness (`executeToolOnState.ts:1447–1466`), colSpans-only bulk shape + reducer merge (`executeToolOnState.ts:1298–1308`; applyMutation.ts spans merge with `Object.hasOwn` + `isSafePatchKey`), `get_field_values`/`query_data_source` limit/offset clamps (`queryTools.ts:105–112, 254–255`), `prompts/get` error sanitization (T2-5), `studio://schema` state gate (T2-1), schema-branch `Object.hasOwn` (T2-4).
- **Policy chokepoints:** `Policy.all` strictest-wins + deny short-circuit; mutation budget consulted for `proposed || mayMutate`; `executeToolWithPolicy` never increments `committedMutations`; both MCP dispatch paths and both chat dispatch paths (skill args-only with `mayMutate: true`, `query_data_source` args-only, built-in execute-then-gate) verified against the purity invariant. Default-policy composition (name-destructive + effects-aware orphan check) intact.
- **MCP mutating-branch mutex:** snapshot is read inside the chained `runMutation` closure — no stale-snapshot window; dispatch-table reads stay concurrent and never write the box.
- **T1-1 / advertisement-vs-authorization:** chat dispatch gate present (`toolDispatch.ts:291`), skill/built-in name-collision drop present for both `skills` and `skillHandlers`, MCP `isToolAllowed` runs before any dispatch, `registeredToolNames` guards the mutation path.
- **privateMode:** excluded tools unadvertised _and_ dispatch-rejected; `contextEnricher` skipped in `handleAIChat`; `pageSnapshot`-gated `summarise_page` excluded; server `privateMode || body.privateMode` one-way.
- **Approval race:** duplicate-`toolCallId` guard, timeout, abort listener cleanup, `finally` map deletion; `approvalFallback` default-deny; display input rebound to real entity titles.
- **Loop/stream lifecycle:** per-tool exceptions caught on both transports (invariant 5 holds — a throwing `plan` becomes `{error}` tool output, not a dead stream); `ReadableStream` cancel → abort propagation; `enqueue` guarded post-cancel; token/turn/mutation budgets all surfaced as documented.
- **`projectStateForAI`** is the single redaction home for both read surfaces; `doc.ai` reduced to thread metadata; rows/adapter stripped; distinct values capped.
- **`chartRenderer`**: no NaN-geometry regression; only cosmetic residuals (a 100%-single-slice pie/donut renders a degenerate arc; `renderPie` lacks the explicit "No data provided." placeholder its siblings have but is NaN-safe because slices require `value > 0` and legend percent is `total > 0`-guarded) — Tier 3, not written up.

## Not re-reported (documented design decisions)

`hidden` as a listing-only flag; MCP allow-all default policy; `resources/list`/`completion` ungated as
listing surfaces; skill `promptFragment` trusted prose behind `allowedSkills`; `summarise_page` running
live queries under its own tool name (each tool individually allow-listed and policy-consulted);
`add_widget`/`update_widget` `sourceId` not validated against `runtime.dataSources` (sources are
host-injected per request and may legitimately lag the persisted document).
