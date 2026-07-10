# Architecture Review — `@mui/x-studio-ai-middleware`

Fresh, clean-slate review grounded in a full read of the current source (not prior findings).
The package remains in strong shape: the trust-boundary invariants documented in `ARCHITECTURE.md`
(the `hasOwn`/authorization guards in `executeToolOnState.ts`, the `prompts/get`/resource
authorization gates, the `sanitizeForPrompt` structural choke point in `describeWidget`, the
`VALID_FIELD_TYPES`/`BUILTIN_WIDGET_KINDS`/`STUDIO_FILTER_OPERATORS` completeness locks, and the
same-batch chart-type tracking in `apply_bulk_update`) all hold on re-read. In particular:

- Every prompt-region interpolation of a state-derived string I could find routes through
  `sanitizeForPrompt` (including the `number`-typed `richContext`/`enrichedContext` fields, the
  `resources/list` metadata, `prompts/get`, `generateFieldDescriptions`, and `handleCreateWidget`).
  No sixth un-sanitized entry point surfaced.
- The advertised-tool (T1-1), private-mode (T1-2/registry-derived), `allowedTools` (T1-3), and
  resource/prompt authorization-parity gates are all present and correctly ordered on both
  transports. I found no authorization-bypass, prompt-injection, or data-exfiltration class issue.
- The mid-batch `currentChartTypes`/`addedWidgetKinds` tracking in `apply_bulk_update` is correct;
  the reducer's spans-only-merge vs rows-present-replace reconciliation matches the producer.

**Summary: Tier 1: 0 · Tier 2: 2 · Tier 3: 1**

No Tier 1 (authorization-bypass / prompt-injection / exfiltration) issue was found. The Tier 2
items are a robustness/consistency gap and a prompt-vs-validation capability mismatch.

---

## Tier 2

### T2-A · MCP `tools/call` dispatch resolves model-supplied tool names through the prototype chain (`toolHandlers[toolName]`)

**File:** `src/mcp.ts:433` (`const handler = toolHandlers[toolName];`), executed at `:449`
(`return await handler(args);`).

`toolHandlers` is a plain object literal (`{ ...createDataToolHandlers(...) }`, plus
`toolHandlers.summarise_page` when `data` is present — see `src/mcp.ts:282-302`). `toolName` comes
straight off the untrusted MCP request (`request.params.name`, `src/mcp.ts:412`). The low-level
`@modelcontextprotocol/sdk` `Server` does **not** validate the requested name against a registered
tool list before invoking this handler, so an MCP client can send `tools/call` with any string.

Because the lookup is a bare `toolHandlers[toolName]` (not `Object.hasOwn`-guarded), a name that is
an `Object.prototype` member resolves to a truthy inherited value:

- `toolName: "constructor"` → `handler = Object` (the function) → `if (handler)` passes → the
  args-only policy consult runs → `return await handler(args)` calls `Object(args)`, returning the
  raw args object as the "tool result" — a value that is **not** a valid `CallToolResult` (no
  `content` field), which the SDK then fails to serialize.
- `toolName: "toString"` / `"valueOf"` / `"hasOwnProperty"` → `handler` is the corresponding
  `Object.prototype` method → invoked as `handler(args)` with `this === undefined`, throwing a
  `TypeError` that is caught by the outer `try/catch` (`src/mcp.ts:509`) and returned as
  `errorResult(String(err))`.
- `toolName: "__proto__"` → `handler = Object.prototype` (truthy, non-callable) → `handler(args)`
  throws "handler is not a function", again caught.

**Concrete failure scenario:** an MCP client (or a prompt-injected upstream agent driving an MCP
client) calls `tools/call name="constructor"`. In the default configuration (`allowedTools`
omitted → `isToolAllowed` returns `true` for every name, `src/mcp.ts:250,423`), the call is not
rejected as unknown; it reaches `Object(args)` and returns a malformed result / triggers an SDK
serialization error instead of the clean `errorResult("Unknown tool: constructor")` that every
other unrecognized name receives (via the `registeredToolNames` fallthrough at `src/mcp.ts:454`).

**Severity note (why Tier 2, not Tier 1):** this is a robustness/consistency defect, not a
privilege escalation. The reachable prototype members are `Object.prototype` methods — none mutates
`StudioState`, queries data, or exposes anything the already-available real tools don't. When a host
supplies an `allowedTools` allow-list, `isToolAllowed("constructor")` is `false` and the call is
rejected before the lookup, so the gap only exists in the allow-all default (where all real tools
are available anyway). But it violates the package's own T2-1 discipline — "every model-supplied
key lookup on a plain object goes through `Object.hasOwn`" — at the one dispatch site that then
_calls the resolved value_.

**Sibling-site sweep (invariant: every model/client-supplied key used to index a plain-object map
must be `Object.hasOwn`-guarded or resolved through a `Map`/`Set`).** All plain-object dynamic
lookups keyed by model-supplied strings in the package:

- `src/mcp.ts:433` — `toolHandlers[toolName]` — **material and unguarded** (the value is then
  invoked). This finding.
- `src/executeToolOnState.ts:1631` — `(TOOL_IMPLS as Record<…>)[toolName]` — same prototype hazard,
  but **safe by accident**: the result is only used via `impl?.effect === 'pure'`, and no
  `Object.prototype` member has `.effect === 'pure'`, so it falls through to the `Unknown tool`
  error. Worth hardening for parity.
- `src/executeToolOnState.ts:1299` and `:1367` — `addedTitleToId[ref] ?? ref` (the `apply_bulk_update`
  layout and `colSpans` loops). `ref` is a fully model-chosen widget _title_ string, so
  `ref: "constructor"` resolves `addedTitleToId["constructor"]` to the `Object` function. **Fails
  safe**: the resolved function is not in `liveWidgetIds` (a `Set`, so `.has` doesn't walk the
  prototype), and the op is pushed onto `skipped` — but with a garbled message
  (`[Object function]` stringified into the error text) rather than the intended
  "widget not found" wording.
- `src/executeToolOnState.ts:1229` — `addedWidgetKinds[wid]` — reachable only after
  `liveWidgetIds.has(wid)` passes (a `Set`), and widget ids are server-minted (never a prototype
  name), so **not reachable** with a hostile key today. Latent.

Every other keyed lookup I checked (`src/mcp/queryTools.ts:61`, `src/mcp/resources.ts:385,446`,
`src/mcp/summarisePage.ts:59`, `src/agenticLoop/toolDispatch.ts:150-152`,
`src/buildAISystemPrompt.ts:690`) is already `Object.hasOwn`-guarded, or keyed by ids drawn from
state (`widgetRows.flat()`, `Object.keys(...)`) rather than raw model input.

**Suggested fix direction:** guard the dispatch lookup the same way the rest of the package does —
`const handler = Object.hasOwn(toolHandlers, toolName) ? toolHandlers[toolName] : undefined;` — and,
for defense-in-depth, hoist the `registeredToolNames`/known-name check to reject unknown names
before either dispatch branch. Optionally apply `Object.hasOwn` to the `TOOL_IMPLS` lookup and route
`addedTitleToId` resolution through a `Map` (or `Object.hasOwn`) so the sibling sites stop relying on
downstream `Set` membership and produce clean error text.

---

### T2-B · System prompt instructs the model to set `crossFilterMode` on "any widget", but the write-side validation rejects it on every non-chart kind

**Files:**

- Prompt (read-side, tells the model it can do this):
  `src/buildAISystemPrompt.ts:470-488` — the static `## Cross-Widget Interaction` section:
  `### crossFilterMode (any widget)` … "Controls how **this widget** responds …" and the
  "Wiring pattern: 'clicking Chart A should filter Chart B' — Chart B needs:
  `crossFilterMode: "cross-filter"`". `describeWidget`'s **map** branch also reports it
  (`src/buildAISystemPrompt.ts:302-304`).
- Validation (write-side, rejects it): `invalidConfigKeyError` →
  `validateConfigKeysForKind` (`src/executeToolOnState.ts:221-226`), applied by `update_widget`
  (`:642`), `buildWidgetFromArgs` for `add_widget`/bulk additions (`:461`), and the bulk updates
  loop (`:1230`).
- Root cause (upstream): in `@mui/x-studio-schema`, `crossFilterMode` is declared only on
  `StudioChartConfigBase` (`packages/x-studio-schema/src/widgetTypes.ts:207-214`), so it appears
  only in the per-chart-family key tuples in `configKeyValidation.ts` — **not** in
  `SHARED_CONFIG_KEYS` nor in `GRID_/KPI_/PIVOT_/MAP_CONFIG_KEYS`. Therefore
  `getAllowedConfigKeys('grid'|'kpi'|'pivot'|'map')` excludes `crossFilterMode`, and
  `validateConfigKeysForKind('grid', { crossFilterMode: 'cross-filter' })` returns
  `['crossFilterMode']` (invalid).

**Concrete failure scenario:** a user asks "make clicking the sales chart filter the orders table".
Following the prompt's own wiring pattern, the model calls
`update_widget({ widgetId: <grid>, config: { crossFilterMode: "cross-filter" } })`. Because the
target is a `grid` (not a `chart`), `invalidConfigKeyError` returns
`"config carries key(s) not valid for a 'grid' widget: crossFilterMode"` and the tool call is
rejected (fail-closed, `nextState: state`). The same rejection occurs for `kpi`, `pivot`, and `map`
targets — precisely the responding-widget kinds the "any widget" instruction and the
`GridSetupPanel`/`KpiSetupPanel`/`MapSetupPanel` UI toggles are built for. The runtime widgets
_read_ `config.crossFilterMode` (e.g. `StudioGridWidget.tsx`, `StudioKpiWidget.tsx`), so the
capability is real — the model simply can't reach it through the tools.

**Sibling sweep (invariant: the config keys the prompt advertises as settable per widget kind must
match the keys the write-side allow-list accepts for that kind).** `crossFilterMode` is the only key
with this cross-kind mismatch:

- `crossFilterField` (grid) — correctly listed in `GRID_CONFIG_KEYS`. OK.
- `mapCrossFilterEmit` (map) — correctly listed in `MAP_CONFIG_KEYS`. OK.
- `describeWidget` reports `crossFilterMode` for the `chart` branch (gated by
  `getAllowedChartConfigKeys`, valid) and unconditionally for the `map` branch
  (`src/buildAISystemPrompt.ts:302-304`) — the map read-side surfaces a key the write-side can never
  land, so that map branch is effectively dead for AI-authored widgets.

Note this is _not_ a client/server divergence — the client's `StudioController.updateWidgetConfig`
applies the same `validateConfigKeysForKind` and warn-and-strips `crossFilterMode` on non-chart
kinds too. The mismatch is specifically between the **shipped prompt text** (which promises the
capability) and the **validation** (which denies it).

**Suggested fix direction:** the correct fix is upstream — move `crossFilterMode` into the shared
config surface (`StudioSharedWidgetConfig` + `SHARED_CONFIG_KEYS`), since it is honored across
chart/grid/kpi/pivot/map — so `validateConfigKeysForKind` accepts it for every kind that reads it.
That is an `@mui/x-studio-schema` change, out of this package's tree, so if it must stay
middleware-local, the alternative is to stop advertising the capability for non-chart kinds in
`STUDIO_AI_INSTRUCTIONS` (scope "### crossFilterMode" to chart widgets) and drop the unreachable
`crossFilterMode` line from `describeWidget`'s map branch — but that narrows a real product feature
and is the weaker fix.

---

## Tier 3

### T3-A · `apply_bulk_update` title-ref resolution and error messages degrade oddly on prototype-named titles

**File:** `src/executeToolOnState.ts:1299,1367` (folded into T2-A's sibling sweep, called out
separately here because the observable symptom is a distinct, low-value cosmetic issue).

A model can give an added widget any `title`, and layout/`colSpans` references are resolved by title
through `addedTitleToId[ref] ?? ref`. When `ref` is an `Object.prototype` member name
(`"constructor"`, `"toString"`, …) and no widget with that exact title was added in the batch,
`addedTitleToId[ref]` resolves to the inherited function rather than `undefined`, so `?? ref` does
not fall through to the raw ref. The op is still correctly skipped (the resolved function fails the
`liveWidgetIds` `Set` membership check), but the `skipped` message interpolates the stringified
function (`"colSpan function Object() { [native code] }: widget not found."` /
`"layout: unknown or removed widget IDs: function Object() …"`) instead of the clean ref the model
supplied. No state corruption, no incorrect targeting (a real widget titled `"constructor"` shadows
the prototype member with its own minted id, so legitimate resolution is unaffected).

**Suggested fix direction:** resolve title refs through a `Map<string,string>` (or
`Object.hasOwn(addedTitleToId, ref) ? addedTitleToId[ref] : ref`) so an unmatched ref always falls
through to the raw model string and the skip message reads back the exact ref the model sent.
Fixing this is the same one-line change as T2-A's sibling hardening at these two lines.
