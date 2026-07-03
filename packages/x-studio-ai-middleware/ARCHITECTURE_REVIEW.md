# Architecture Review — `@mui/x-studio-ai-middleware`

Independent ground-up review of the current source (post `mcp/` decomposition, `applyMutation` extraction to `@mui/x-studio-schema`, and agentic-loop abort/timeout fixes). Every finding was verified against the code as it stands today; `ARCHITECTURE.md` was used as a map and spot-checked along the way (it is accurate on everything checked, with one nuance noted in T1-3).

Overall assessment: the package is in substantially better structural shape than a typical post-refactor codebase. The single-reducer (`applyMutation`) design, the compile-time tool-name drift guard, the boxed-state MCP session model, and the bounded approval wait are all sound and correctly implemented. The remaining issues cluster around **tool gating being advertisement-only on the chat path**, **unvalidated model-supplied layout/bulk arguments that can poison state**, and **stringly-typed MCP tool metadata that has already drifted**.

---

## Tier 1 — Correctness / security bugs

### T1-1 (High) — Chat loop executes tools that were never advertised: `allowedTools` is advertisement-only, not enforcement

`src/agenticLoop.ts` — tool dispatch (`execute_query` branch ~line 564, `executeToolOnState` fallthrough ~line 707).

The effective tool list (`builtInTools` filtered by `allowedTools`, `dataResolver`, `pageSnapshot`) controls only what is _advertised_ to the model. The dispatch path never checks that a returned tool call is in that list:

- If a host sets `allowedTools: ['get_dashboard_state', 'list_pages']` to build a read-only assistant, a model induced (e.g. by prompt injection in a widget title — a threat the system prompt itself acknowledges) to emit `remove_page` or `apply_bulk_update` will have it **executed** by `executeToolOnState`.
- Worse: `execute_query` is special-cased _before_ any gating check. If a `dataResolver` is configured but the host excluded `execute_query` from `allowedTools`, an injected call still runs raw SQL through the resolver.

The MCP transport gets this right (`mcp.ts` rejects tools not in `toolsToRegister` — modulo T1-3), so the two transports currently enforce different security contracts over the same tool set.

**Recommendation:** before dispatching each tool call, verify `tc.name` is in the effective set (advertised built-ins ∪ declared skill tools). Unknown/unadvertised names should produce the same `{ error: 'Unknown tool …' }` output the default case already produces — never execute. Add a regression test: `allowedTools: ['get_dashboard_state']` + a synthetic `remove_page` tool call must not mutate state.

### T1-2 (High) — `privateMode` is defeated by `get_dashboard_state` / `list_pages` tool output

`src/agenticLoop.ts` (tool gating, ~line 249) + `src/executeToolOnState.ts` (`get_dashboard_state`, line 47).

`privateMode` omits `<dashboard_state>` from the system prompt so "the dashboard contains sensitive business data" is never sent to the LLM provider. But the state-reading tools remain advertised and functional: the model calls `get_dashboard_state` (its description actively encourages it), receives `JSON.stringify(state)` — which includes `fieldDistinctValues` (real data values), widget configs, filter values, source labels — and that JSON is fed back to the provider in the tool-result message on the next turn. One innocent tool call round-trips exactly the data `privateMode` promised to withhold.

**Recommendation:** when `privateMode` is set, either (a) filter `get_dashboard_state`, `list_pages`, and `summarise_page` out of `builtInTools` (like `execute_query` without a resolver), or (b) return a redacted structural view (ids/kinds only, no titles, no `fieldDistinctValues`, no filter values). Document the choice in `models/protocol.ts` next to `privateMode`.

### T1-3 (Medium-High) — MCP dispatch table bypasses `allowedTools` for special-cased tools

`src/mcp.ts` lines 239–247.

In `tools/call`, the `toolHandlers` dispatch-table lookup runs **before** the `toolsToRegister` membership check. `get_dashboard_state` (always in the table) and `summarise_page` (in the table whenever `data` is configured) are therefore callable even when the host's `allowedTools` explicitly excludes them — e.g. `allowedTools: []` still serves the full dashboard state to any MCP client. `StudioMcpOptions.allowedTools` documents itself as "Subset of STUDIO_AI_TOOL names to expose via MCP", and both names are STUDIO_AI_TOOL names, so this is a gating bypass, not a documented carve-out. (The always-on availability of `render_chart`/`get_recent_changes`/data tools is arguably by design since they are not STUDIO_AI_TOOLS — but that should be stated in the `allowedTools` doc.)

**Recommendation:** for tool names that exist in `STUDIO_AI_TOOLS`, check `toolsToRegister` membership _before_ the `toolHandlers` lookup. Add an MCP test with `allowedTools: ['add_page']` asserting `get_dashboard_state` returns `Unknown tool`.

### T1-4 (Medium) — `set_widget_layout` and `apply_bulk_update.layout` accept unvalidated rows that can poison state

`src/executeToolOnState.ts` — `set_widget_layout` (lines 197–215), `apply_bulk_update` layout step (lines 449–455).

- `set_widget_layout` only checks `Array.isArray(rows)`. A flat `["w1","w2"]` (the exact mistake the system prompt warns the model about) passes the check, and `applyMutation` assigns it verbatim to `widgetRows`. Every downstream consumer that does `row.map(...)` / `row.filter(...)` on what is now a _string_ will throw — including `buildDashboardState` on the very next turn, killing the request. Row entries are also never validated against `state.widgets`, so unknown ids and omitted widgets (orphans) go straight into state.
- `apply_bulk_update` resolves layout refs via `addedTitleToId[ref] ?? ref` with no fallback validation: a mistyped title or stale id is stored as a phantom "widget id" in `widgetRows`.

**Recommendation:** validate shape (`rows.every(r => Array.isArray(r) && r.every(id => typeof id === 'string'))`) and membership (each id ∈ page widgets ∪ just-added widgets). Reject with a descriptive `{ error }` on shape violations; collect unknown refs into the existing `skipped` array for bulk updates. This is exactly the class of tool-argument assumption the malformed-JSON guard was added for — the arguments here are valid JSON but invalid _content_.

### T1-5 (Medium) — `apply_bulk_update` removals of widgets on other pages leave dangling layout references

`src/executeToolOnState.ts` lines 367–379.

The removal loop checks `pageWidgets[wid]` — a copy of the **global** `state.widgets` — but only rewrites the **active page's** `widgetRows`. Removing a widget that lives on another page deletes it from `widgets` while leaving its id in that page's `widgetRows` (the `applyBulkUpdate` reducer replaces `state.widgets` wholesale and touches only the active page). Result: dangling widget ids in a non-active page — precisely the inconsistency `removeWidget`'s reducer sweeps all pages to avoid. The tool schema says "IDs of widgets to remove from the active page", but nothing enforces it.

**Recommendation:** treat a removal id not present in the active page's `widgetRows` as `skipped: 'remove <id>: not on the active page'`, mirroring the not-found handling.

### T1-6 (Medium) — `TOOL_ANNOTATIONS` mislabels `apply_bulk_update` as non-destructive and idempotent

`src/mcp/toolMetadata.ts` line 118.

`apply_bulk_update: { destructiveHint: false, idempotentHint: true, … }` — but the tool mass-removes widgets (`widgetRemovals`), and repeated identical calls with `widgetAdditions` create duplicate widgets (not idempotent). The chat transport treats the same tool as destructive (it is in `TOOLS_REQUIRING_APPROVAL`); MCP clients like Claude Desktop use these hints to decide whether to prompt the user, so this materially weakens the confirmation flow on MCP. Similarly `add_*` tools correctly omit `idempotentHint`, which shows the intent — this one entry is just wrong.

**Recommendation:** `apply_bulk_update: { destructiveHint: true, openWorldHint: false }`. See T2-2 for eliminating the root cause (three independent encodings of destructiveness).

### T1-7 (Low) — MCP `summarise_page` sections are emitted in query-completion order, not page order

`src/mcp/dataTools.ts` lines 447–575: widgets are summarised concurrently via `widgets.map(async …)` and each pushes into a shared `sections` array on completion, so the per-widget sections in the final summary are ordered by query latency — non-deterministic and unrelated to the page layout the user sees.

**Recommendation:** write results into a pre-sized indexed array (`results[i] = …`) inside the map, then filter nulls, preserving widget order.

### T1-8 (Low) — MCP `summarise_page` anomaly aggregation sums per-bucket values even for `avg`/`min`/`max` series

`src/mcp/dataTools.ts` line 552: `grouped.set(periodKey, (grouped.get(periodKey) ?? 0) + Number(row.y_agg ?? 0))`. When the widget's `yAggregation` is `avg`, `min`, or `max`, summing the per-x-value aggregates into a period bucket is mathematically wrong (a sum of daily averages is not a monthly average), which skews `detectAnomaliesIQR` input and can produce false anomaly flags.

**Recommendation:** either restrict the anomaly path to `sum`/`count` (skip otherwise), or combine per the aggregation (`min` of mins, `max` of maxes, weighted mean for `avg` — the last needs a count column, so skipping is more honest).

### T1-9 (Low) — A throwing `onStateChange` reports the tool call as failed after the mutation was applied

`src/mcp.ts` line 275: `await onStateChange?.(…)` sits inside the same `try` as the tool execution. If the host's persistence callback throws, the client receives `errorResult(...)` even though `stateBox.current` already advanced and the change is in `recentChanges` — the MCP client's view of success now disagrees with the session state.

**Recommendation:** wrap the `onStateChange` await in its own `try/catch` that logs via `logger?.error` and still returns the success payload.

### T1-10 (Low) — Tool-call delta index fallback can collide with provider-supplied indices

`src/agenticLoop.ts` lines 379–394: synthetic indices for id-only deltas start at `nextAutoIdx = 0`. In a mixed stream where some deltas carry `index` and others only `id` (never both for the same call), a synthetic index `0` collides with a real `index: 0` call and the two calls' fragments merge. Theoretical with current providers, but the fallback exists precisely for nonconforming providers.

**Recommendation:** seed synthetic indices from a disjoint range (e.g. `1_000_000 +`) or key the accumulator by `id ?? index`.

### T1-11 (Low) — `handleAIChat` leaks an abort listener on long-lived external signals

`src/handleAIChat.ts` line 301: the listener added to `options.signal` (`{ once: true }`) is only removed if the signal fires. A host reusing one long-lived signal across many requests accumulates one listener per request forever. Also minor: `toOpenAIMessages` (`src/agenticLoop.ts` line 87) drops an assistant message's text when it also has tool parts, and skips tool results with `output === undefined` — the latter can replay a history that violates the OpenAI requirement that every `tool_calls` entry be followed by a tool message, producing a 400 on the next turn.

**Recommendation:** remove the listener in the stream's `finally`; emit a placeholder tool result (`{"status":"unknown"}`) for undefined outputs.

---

## Tier 2 — Structural duplication

### T2-1 (High) — Widget construction logic duplicated between `add_widget` and `apply_bulk_update` additions

`src/executeToolOnState.ts` lines 121–134 vs 393–414. The full sequence — `createDefaultWidget(kind)` → layer `customWidgets[].defaultConfig` → layer model config → generate `widget-${Date.now()}-…` id — is implemented twice, character-for-character. Any future change (id scheme, validation of `sourceId` against `state.dataSources`, config sanitization) must be made in both or they silently diverge; the divergence in _removal_ semantics between the two paths (T1-5) shows this is not hypothetical.

**Recommendation:** extract `buildWidgetFromArgs(args, customWidgets): StudioWidget` (and a `generateId(prefix)` helper — the `${prefix}-${Date.now()}-${Math.random()…}` pattern appears four times in this file).

### T2-2 (High) — "Which tools are destructive" is encoded independently in three places

1. `TOOLS_REQUIRING_APPROVAL` set in `src/agenticLoop.ts` line 231 (chat approval gating)
2. `destructiveHint` values in `src/mcp/toolMetadata.ts` (MCP client confirmation)
3. Prose in tool descriptions in `src/studioAITools.ts` ("This action requires user confirmation…")

They have already drifted (T1-6): `apply_bulk_update` is approval-gated in chat but advertised as safe/idempotent to MCP clients. There is no guard tying them together, unlike the tool-name union which got a compile-time assert.

**Recommendation:** declare destructiveness once — e.g. a `DESTRUCTIVE_TOOLS: ReadonlySet<StudioAIToolName>` exported from `studioAITools.ts` — and derive both the agentic-loop set and the MCP `destructiveHint` defaults from it.

### T2-3 (Medium) — `TOOL_TITLES` / `TOOL_ANNOTATIONS` are stringly-keyed and have already drifted

`src/mcp/toolMetadata.ts` lines 13–41: `TOOL_TITLES` is `Record<string, string>` with no compile-time tie to `StudioAIToolName`. Concrete drift today:

- `list_pages` is **missing** from `TOOL_TITLES` (so MCP `tools/list` emits `title: undefined` for it) while present in `TOOL_ANNOTATIONS`;
- `get_current_date` (line 34) is a phantom entry for a tool that exists nowhere in the package.

**Recommendation:** type them as `Record<StudioAIToolName | McpExtraToolName, …>` (where `McpExtraToolName` is the union of the data/extra tool names). Missing/phantom keys then become compile errors, exactly like the `STUDIO_AI_TOOLS` drift guard.

### T2-4 (Medium) — `mcpTruncateToPeriod` / `mcpIsoWeek` still mirror the client's `temporalUtils.ts` by hand

`src/mcp/dataTools.ts` lines 36–89. The header comment justifies keeping a local copy because the client's `temporalUtils.ts` "also pulls in unrelated pipeline code" — but that rationale predates `@mui/x-studio-schema`, which now exists precisely to host zero-dependency pure functions shared by client and server (`detectAnomaliesIQR` already made the move from the same feature). The mirrored fallback comment ("Includes the same fallback as `normalizeToDate`") is a hand-sync promise that will eventually break.

**Recommendation:** move `truncateToPeriod`/`isoWeek` into `@mui/x-studio-schema` next to `anomalyDetection.ts`; have the client's `temporalUtils.ts` and `dataTools.ts` both import them.

### T2-5 (Low) — Minor duplications, acceptable but worth a pass

- `add_page_filter` / `add_widget_filter` (`executeToolOnState.ts` lines 291–340) differ only in `scope` and one required arg — a shared `buildFilterFromArgs(args, scope)` would halve them.
- SVG→base64 image-content assembly duplicated between `render_chart` and the `get_field_values` auto-chart (`mcp/dataTools.ts` lines 124–137 vs 333–342) — a `svgImageContent(svg)` helper in `mcp/helpers.ts` fits.
- The `Math.round(avg * 100) / 100` stat-rounding and the `!source || !source.tableName → errorResult('Unknown data source…')` lookup appear in three data-tool handlers each; a `resolveTabledSource(stateBox, sourceId)` helper would centralize both.
- The `toolResults.push(...)` + `yield { type: 'tool-activity', phase: 'complete', … }` pair appears seven times in `agenticLoop.ts` with subtly inconsistent ordering (the built-in path yields before pushing; every other path pushes first). Harmless today, but it is the same event contract written seven times — see T3-1.

Not flagged: the chat-vs-MCP availability gating for `execute_query`/`summarise_page` living in two places is a deliberate, documented per-transport contract difference (`ARCHITECTURE.md`), not accidental duplication.

---

## Tier 3 — God-files / structural cohesion

### T3-1 (Medium) — `runAgenticLoop` is a single ~560-line async generator with five inline dispatch regimes

`src/agenticLoop.ts` lines 203–765. The `mcp.ts` decomposition worked; this is now the least cohesive unit in the package. One function body contains: message serialization concerns, effective-tool computation, HTTP/SSE consumption, tool-call delta accumulation (with the index-fallback state machine), budget enforcement, and five distinct tool dispatch paths (parse-failure, server-tool skill, `execute_query`, unregistered skill, approval + built-in), each re-emitting the result/event pair by hand (T2-5). It is well-commented and well-tested, but every new tool-dispatch concern (e.g. the enforcement fix in T1-1) grows the same function.

**Recommendation:** extract three pure/self-contained helpers, keeping the generator as the orchestrator: `accumulateToolCallDeltas(chunk, acc)` (the index/id bookkeeping), `waitForApproval(tc, approvalPending, signal, timeoutMs): Promise<ApprovalOutcome>`, and a `dispatchToolCall(tc, ctx): Promise<{ output; mutation?; nextState? }>` that owns the five-way branch and returns a uniform result the loop turns into events exactly once. No behavior change; ~250 lines out of the generator.

### T3-2 (Low-Medium) — `mcp/dataTools.ts` is the new growth point in the `mcp/` folder

597 lines mixing four query handlers, `render_chart`, `get_recent_changes`, the 180-line `createSummarisePageHandler` (itself containing stats, CSV excerpting, time-series aggregation, and anomaly trimming), and the temporal helpers. Still coherent, but it is the only `mcp/` module trending toward the old `mcp.ts` shape.

**Recommendation:** split `createSummarisePageHandler` (plus the temporal helpers, or better, after T2-4, minus them) into `mcp/summarisePage.ts`. `dataTools.ts` then holds only the uniform "validate source → query → shape result" handlers.

### T3-3 (Info) — The rest is holding up well

- `mcp.ts` (314 lines) is a genuine composition root: session state + wiring only. The dispatch-table pattern means new data tools are table entries. Healthy.
- `executeToolOnState.ts` (597 lines) is a flat switch with one oversized case (`apply_bulk_update`, ~127 lines) — extracting that case into a named function is worthwhile when touching it for T1-4/T1-5, but the file is not a God-file: one concern, uniform shape.
- `buildAISystemPrompt.ts` (772 lines) is dominated by prompt copy (a module constant) and per-kind describers; fine.
- `mcp/toolMetadata.ts` (429 lines) is pure data; fine (modulo T2-3 typing).
- The `models/studioTypes.ts` / `widgetFactory.ts` shims over `@mui/x-studio-schema` are clean: pure re-exports plus the one deliberately server-local type (`StudioCustomWidgetDef`, React-free subset) with the rationale documented in place. One nit: `widgetFactory.ts`'s comment ("The implementation lives in models/studioTypes.ts") is stale — it lives in the schema package now; and `index.ts` lines 40–42 still claim `SerializableSkill`/`StateMutation`/`StudioAIToolName` are "defined locally (mirrored in @mui/x-studio…)", which the schema extraction made false. Update both comments.

---

## Tier 4 — Testing gaps

Coverage is genuinely strong for the loop (rate limits, gating, malformed args, approval races, skills, delta fallback), `executeToolOnState`'s per-tool contracts, and the MCP resource/prompt/query surface. The gaps that remain are specific:

1. **(High) `mcp/dataTools.ts` query handlers have zero direct tests.** `describe_data_source`, `get_field_values`, `compute_field_stats`, and `render_chart` do not appear in `mcp.test.ts` or the integration test at all (`grep` count: 0). That is ~300 lines of parallel-query fan-out, stat shaping, and best-effort chart embedding with no safety net — notably `describe_data_source`'s `Promise.all` positional alignment of `statsResults` with `numericFields`, and `get_field_values`'s ≥2-datapoint chart threshold.
2. **(High, pairs with T1-1/T1-3) No gating-enforcement tests.** Nothing asserts that an MCP call to a tool excluded by `allowedTools` is rejected (this would have caught T1-3), nor that the chat loop refuses an unadvertised tool call (blocked on fixing T1-1).
3. **(Medium) `rename_thread` has zero coverage anywhere** — the 40-char trim, the non-string rejection, and the server-stamped `updatedAt` contract (explicitly called out as a design invariant in `ARCHITECTURE.md`) are all untested. `list_pages`'s handler output (widget titles, `isActive`) is likewise untested (it appears in `agenticLoop.test.ts` only as a name in a gating assertion).
4. **(Medium) `apply_bulk_update` is tested only on happy paths.** No tests for: layout title→id resolution, `skipped` reporting, colSpan clamping (3–12), the `layout` step, or cross-page removals (T1-5). Given this is the designated "3+ changes" workhorse and approval-gated, it deserves the deepest matrix in the file, not the shallowest.
5. **(Low) `mcpTruncateToPeriod` / `mcpIsoWeek`** are exercised only through one month-granularity anomaly test; `week` (ISO edge years), `quarter`, `year`, the numeric-timestamp fallback, and invalid-date rejection are untested. (Moot if T2-4 moves them to the schema package — then test them there.)
6. **(Low) Resource subscription notifications**: the subscribe/unsubscribe test only asserts the handlers "run without error"; nothing asserts `sendResourceUpdated` fires for subscribed URIs after a mutating tool call (the actual feature), nor the immediate notify-on-subscribe behavior in `resources.ts`.

---

## Summary of recommended actions (by priority)

| #   | Action                                                                                                                                                  | Findings               |
| :-- | :------------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------- |
| 1   | Enforce the effective tool set at dispatch time in the chat loop; fix MCP dispatch-order bypass; add gating tests                                       | T1-1, T1-3, T4-2       |
| 2   | Gate or redact state-reading tools under `privateMode`                                                                                                  | T1-2                   |
| 3   | Validate layout rows / bulk-update refs and active-page removals                                                                                        | T1-4, T1-5, T4-4       |
| 4   | Fix `apply_bulk_update` annotations; centralize destructiveness in one exported set                                                                     | T1-6, T2-2             |
| 5   | Type `TOOL_TITLES`/`TOOL_ANNOTATIONS` against the tool-name unions (fixes `list_pages`/`get_current_date` drift)                                        | T2-3                   |
| 6   | Add direct tests for the MCP data-tool handlers and `rename_thread`                                                                                     | T4-1, T4-3             |
| 7   | Extract widget-construction/id helpers; split `dispatchToolCall`/approval-wait out of `runAgenticLoop`; move temporal helpers to `@mui/x-studio-schema` | T2-1, T3-1, T3-2, T2-4 |
| 8   | Small fixes: summarise-page ordering & aggregation, `onStateChange` isolation, abort-listener cleanup, stale shim comments                              | T1-7…T1-11, T3-3       |
