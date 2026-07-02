# Architecture & technical-debt review (Fable)

Independent review by the Fable model, run in two passes: (1) a review of `ARCHITECTURE.md` across all three Studio packages, verified against source and extended with new findings; (2) a dedicated technical-debt sweep of this package. Read-only analysis — no code was changed to produce this report. See also [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the baseline this review evaluates.

Findings marked **cross-cutting** also appear in [`x-studio/ARCHITECTURE_REVIEW.md`](../x-studio/ARCHITECTURE_REVIEW.md) since they span both packages.

---

## Part 1 — Architecture proposals concerning this package

### Proposal: End the hand-synced duplication between x-studio and ai-middleware with a shared zero-dependency package (cross-cutting)

**Problem**: The "structural typing boundary" (this package's ARCHITECTURE invariant #7) has already produced three parallel copies that must be maintained by hand:

- `detectAnomaliesIQR` (`packages/x-studio/src/internals/anomalyDetection.ts:16-36`) vs `mcpDetectAnomaliesIQR` + `mcpMedian` (`src/mcp.ts:383-408`) — byte-for-byte identical logic today; nothing enforces they stay so. The tech-debt sweep below found this has **already drifted**: `mcpTruncateToPeriod`/`mcpIsoWeek` (`mcp.ts:332-364`) don't share `@mui/x-studio`'s `normalizeToDate()` fallback, so a DB driver returning numeric timestamps makes MCP's `summarise_page` silently drop every period bucket while the client shows anomalies fine.
- `createDefaultWidget` duplicated wholesale: `packages/x-studio/src/internals/widgetFactory.ts:14-94` vs `models/studioTypes.ts:508-557` — identical branch-for-branch today.
- The entire 557-line `models/studioTypes.ts` re-declares `StudioState`/`StudioWidget`/etc. from the client package — and per the tech-debt sweep, it's **already missing keys** the client's real type has (`heatLegendPosition`, `heatLegendAlign`, `funnelCategoryOrder`, `funnelReachedField`, `funnelStageSequence`, `funnelLabelFormat`, `funnelLabelPlacement`, `textContent`, `textAiEnabled`, and `StudioChartSeries.sourceId`) — while `widgetConfigMeta.ts:60-105` _instructs the LLM to emit exactly those keys_, so the server accepts and forwards config it cannot type-check (this forced the `(s: any)` cast at `mcp.ts:1084`).
- The mirrored `StudioAIToolName` union (`models/aiTypes.ts:148-167` vs `x-studio/src/models/aiTypes.ts:159-179`) is missing `set_widget_forecast` in this package's copy, and **both** copies are missing `list_pages` even though it's a real, handled tool.

**Architectural cost**: Every `StudioState` shape change is a two-package edit with no compiler assistance (structural typing means drift surfaces as a runtime mismatch in AI tool behavior, not a type error) — and the drift has already happened in three separate places, not hypothetically.

**Recommended change**: Create an unpublished-or-published `@mui/x-studio-schema` package (zero runtime deps, no React, no Node built-ins) containing: (a) all `StudioState`/widget/filter/expression/AI-protocol types, (b) pure functions both sides need — `createDefaultWidget`, `createDefaultStudioState`, `detectAnomaliesIQR`/`median`, `truncateToGranularity`/`normalizeToDate`, and the `StateMutation` reducers (see the AI-mutations proposal below). Both packages depend on it; `models/studioTypes.ts` becomes `export * from '@mui/x-studio-schema'`. Derive `StudioAIToolName` from `STUDIO_AI_TOOLS` (`typeof STUDIO_AI_TOOLS[number]['function']['name']`) so it can't drift from the actual tool list. At minimum as an interim step: port the `normalizeToDate` fallback into `mcpTruncateToPeriod` now, and add a type-level sync test (`expectTypeOf<XStudioConfig>().toMatchTypeOf<LocalConfig>()`) so further drift breaks CI instead of shipping silently.

**Effort/risk**: Medium-large mechanically (import-path churn across both packages) but low semantic risk — it's a move, not a rewrite. Biggest payoff of any proposal for long-term maintenance.

### Proposal: AI mutation semantics are implemented three times and already disagree (cross-cutting)

**Problem**: Every AI tool's state effect exists twice as executable code: the server computes `nextState` inline (`src/executeToolOnState.ts`, e.g. `add_widget` at 102-141 appends `[widget.id]` to `activePage.widgetRows`), and the client independently re-derives the same effect by mapping the `StateMutation` to controller methods (`x-studio/src/components/StudioChatPanel/applyStateMutation.ts:13-140` → `StudioController.addWidget`). There is already a live divergence: the server appends to _its_ `state.dashboard.activePageId` (`executeToolOnState.ts:123`), while the client's `controller.addWidget` uses the _client's current_ `activePageId` — if the user switches pages while the model is thinking, the model is told the widget landed on page A while it actually rendered on page B.

**This package's own tech-debt sweep found a second, concrete instance of the same class of bug**: `remove_page` (`executeToolOnState.ts:290-300`) doesn't clean up orphaned widgets/page-scoped filters or reassign `activePageId` the way `StudioController.removePage` does. Within one agentic turn the server's `nextState` has orphaned widgets and a dangling `activePageId` while the client (which runs the real cleanup) doesn't. On the MCP path, where `stateBox.current` is authoritative, removing the active page leaves `activePageId` dangling permanently — a follow-up `add_widget` then spreads `{...state.pages[activePageId]}` where the page is `undefined` (`executeToolOnState.ts:124-135`), silently writing a malformed page object into persisted state. The same latent spread-of-undefined exists in `set_widget_width` (`executeToolOnState.ts:262`, `...activePage!`).

**Architectural cost**: The AI feature's core correctness contract — "server-threaded state equals client-applied state" — is unenforced and already violated in at least two reachable scenarios (page-target drift, and now confirmed page-removal corruption).

**Recommended change**: Make `StateMutation` the single semantic authority. In the shared schema package (above), define pure reducers `applyMutation(state: StudioState, mutation: StateMutation): StudioState` — one per mutation type, including the client's _full_ `removePage` cleanup semantics (orphan widgets, page filters, `activePageId` reassignment). `executeToolOnState` becomes "parse args → build mutation → `nextState = applyMutation(state, mutation)`"; the client's `applyStateMutation` becomes `controller.commitExternal(applyMutation(controller.getState(), mutation), label)`. Make `add_widget`/`set_widget_width` error explicitly when there is no active page, rather than spreading `undefined`.

**Effort/risk**: Medium. The reducer extraction is mechanical; fixing `remove_page` to match controller semantics is the main behavioral change and is strictly more correct. Add a regression test asserting `remove_page` of the active page leaves a coherent state (none exists today).

### Proposal: Tool-approval pause can hang the SSE stream and its server resources forever

**Problem**: When a destructive tool needs approval, `runAgenticLoop` awaits a bare promise whose resolver is stashed in `approvalPending` (`agenticLoop.ts:599-603`). Nothing else can settle it: the `AbortSignal` is checked only in the fetch/SSE loop (`agenticLoop.ts:300,325`), not raced against this promise, and the loop never deletes its own map entry. If the user closes the tab, the browser never calls the approval endpoint, and even a host-wired abort signal cannot unstick the generator — `handleAIChat`'s `for await` (`handleAIChat.ts:328`) blocks on the generator forever, keeping the stream, closure state, and the map entry alive per abandoned request. Confirmed independently by the tech-debt sweep, which also notes `handleAIChat`'s `ReadableStream` has no `cancel()` handler, so consumer-side cancellation doesn't stop the loop either, and the `controller.enqueue` in the catch block will itself throw once a stream is cancelled.

**Architectural cost**: Unbounded server-side resource leak proportional to abandoned approval prompts; also violates the package's own invariant #5 ("errors never abort the stream — the stream always closes") since this path closes nothing.

**Recommended change**: Race the approval promise against the abort signal and a configurable timeout: `await Promise.race([approvalPromise, abortAsPromise(signal), timeout(options.approvalTimeoutMs ?? 120_000)])`, with `finally { approvalPending.delete(tc.id); }`. On timeout/abort, feed the model `{denied: true, reason: 'approval timed out'}` (timeout) or return silently (abort). Add a `cancel()` to the `ReadableStream` that aborts an internal `AbortController` linked to `options.signal`, and guard the catch-block `enqueue`.

**Effort/risk**: Small. The only semantic change is that indefinite waits become bounded — strictly safer.

### Smaller observation relevant to this package

- **`agenticLoop.ts:109-111`**: an assistant message containing both text and tool calls drops the text when replaying history (`toOpenAIMessages`) — minor conversation-fidelity loss with models that interleave prose and tool calls.

---

## Part 2 — Technical debt: this package (full sweep)

Ordered by impact. No TODO/FIXME/HACK markers exist anywhere in the package source — the debt below is entirely unmarked, which itself argues for the sync tests proposed above rather than relying on comments like "kept in sync".

**1. `remove_page` diverges from the client controller — corrupts server-carried state**
`executeToolOnState.ts:290-300` vs `x-studio/src/store/StudioController.ts:1319-1357`. See the AI-mutations proposal in Part 1 for the full writeup — this is the concrete bug that proposal is built around.

**2. The duplicated type model (`models/studioTypes.ts`) has already drifted behind `@mui/x-studio` — and behind this package's own prompts**
See the shared-schema proposal in Part 1 for the full writeup.

**3. Mirrored `StudioAIToolName` union is doubly stale**
`models/aiTypes.ts:148-167` vs `x-studio/src/models/aiTypes.ts:159-179` vs `studioAITools.ts` (21 tools). See the shared-schema proposal in Part 1.

**4. Confirmed: inlined algorithms in `mcp.ts` duplicate `@mui/x-studio` — with real behavioral drift**
`mcp.ts:332-408` vs `x-studio/src/internals/temporalUtils.ts:233-279` and `anomalyDetection.ts:6-64`. See the shared-schema proposal in Part 1 for the drift details. Additionally, `mcpMutationLabel` (`mcp.ts:539-566`) hand-mirrors `StudioController` ring-buffer labels while missing `setDashboardTitle`/`applyBulkUpdate`/`renameAIThread` cases (they fall through to raw type names).

**5. Chat loop and MCP disagree on the same tool names — "single source of truth" is only partially true**
`mcp.ts:964-974,984-1167` vs `executeToolOnState.ts:44-49,521-540`; `agenticLoop.ts:218`. Mutation tools do share `executeToolOnState` (`mcp.ts:1602`), but: `get_dashboard_state` returns the raw `StudioState` on MCP vs. the rendered system prompt on chat — same tool name, different output contract. `summarise_page` has two independent implementations: MCP runs live server-side queries and honors the `pageId` argument (`mcp.ts:991-992`); the chat path returns a client-prebuilt `pageSnapshot` and **silently ignores `pageId`**, even though the shared tool schema explicitly promises "Pass pageId to summarise a non-active page" (`studioAITools.ts:348,360-364`) — the model will pass `pageId` in chat and get the active page's data mislabeled as the requested page. Approval gating also differs: chat pauses `remove_page`/`remove_widget`/`apply_bulk_update` for human approval; MCP executes them immediately. Fix: fold the `pageId` mismatch (scope the chat snapshot per page or drop the promise from the schema); give `get_dashboard_state` one canonical output in both paths; document or implement MCP-side approval.

**6. Approval wait can hang the SSE stream forever; no abort propagation**
See the tool-approval proposal in Part 1.

**7. Malformed tool arguments are silently coerced to `{}`, then "succeed"**
`agenticLoop.ts:467-472`; `executeToolOnState.ts:188-210 (remove_widget), 290-300 (remove_page), 302-313 (set_active_page)`. When the model streams unparseable JSON args, the loop swallows the parse error and executes the tool with `{}`. Combined with non-validating tools, `remove_widget` with `widgetId: ''` removes nothing yet returns `{"success":true,"widgetId":""}`; `remove_page`/`set_active_page` likewise never check existence (inconsistent with `update_widget`/`rename_page`, which do). The model is told a destructive operation succeeded when it was a no-op. Fix: on JSON parse failure, feed `{"error":"invalid tool arguments: <snippet>"}` back to the model instead of executing; make `remove_widget`/`remove_page`/`set_active_page` return `not found` errors like their sibling cases.

**8. `mcp.ts` is a 2079-line God-file**
Stats helpers (332-408), `query_data_source` JSON schema (410-528), tool title/annotation tables (569-682), a single `CallToolRequestSchema` handler containing ~700 lines of per-tool business logic (957-1657, incl. the ~185-line `summarise_page` at 984-1167), resources (1659-1904), prompts (1906-2027), completions (2029-2076). Protocol wiring, data-analytics business logic, statistics, and schema metadata all change for different reasons; the `tools/call` handler is a chain of 8 special-case `if` blocks before the generic `executeToolOnState` fallthrough, each repeating the same error-result boilerplate (~14 times). Fix: split into `mcp/dataTools.ts`, `mcp/resources.ts`, `mcp/prompts.ts`, `mcp/toolMetadata.ts`, keeping `mcp.ts` as the factory; introduce `errorResult(msg)`/`jsonResult(obj)` helpers and a `Record<string, ToolHandler>` dispatch instead of the if-chain.

**9. `query_data_source` forwards unknown source IDs as physical table names**
`mcp.ts:1210-1211` — `const tableName = source?.tableName ?? sourceId`. For an unknown `sourceId`, the model-supplied string is passed verbatim as `tableName` to the host's `queryDataSource`, unlike its sibling `describe_data_source` which correctly rejects unknown sources (`mcp.ts:1264-1277`). Widens the attack surface (probing arbitrary table names) and produces confusing DB-level errors instead of a helpful message. Fix: return the same `Unknown data source: "<id>"` error `describe_data_source` uses.

**10. Error swallowing and timer leak in MCP `summarise_page`**
`mcp.ts:1139-1143,322-330`. Per-widget query failures are only sent to `logger` (a no-op unless configured); if every widget fails, the client sees "No queryable widgets found on page" — indistinguishable from an empty page, hiding e.g. a down database. `withTimeout` never `clearTimeout`s, so every summarise/aggregation query pins the event loop for up to 15s after resolving, meaningful in serverless hosts. Fix: collect per-widget error strings into a "Skipped widgets" section; clear the timer in a `finally`.

**11. Missing test coverage for the agentic loop's less-common branches**
`agenticLoop.test.ts` (304 lines) covers only rate limiting and tool advertisement gating. Zero tests exist for: the approval flow (`tool-approval-request`, denial output, `approvalPending` resolution), abort/`signal` behavior, server-tool skill execution and its error path, the `execute_query` execution path (only its gating is tested), the unregistered-skill fallback, malformed-args parsing, and the tool-call accumulation fallback when deltas carry `id` but no `index`. These are exactly the branches that regress silently. Fix: extend the existing mocked-SSE harness with an approval test, an abort test, a skill-handler success/throw pair, and a malformed-arguments turn.

**12. Dead code: `dataAnalystSkill` and `pageExplorerSkill`**
`studioSkills.ts:56-89`; `index.ts:69` exports only `dashboardNarratorSkill` and `insightSuggestorSkill`. Both skills are defined, documented, and unused anywhere in the repo. `dataAnalystSkill` instructs the model to call `describe_data_source`/`get_field_values`/`compute_field_stats`/`render_chart` — tools that exist only on the MCP server, and MCP doesn't consume skills at all, so as written they're unusable in either path. Fix: either delete them, or wire the MCP data tools into the chat loop and then export the skills — they read like an intended follow-up that never landed.

**13. Type-safety gaps at the OpenAI wire boundary + stale casts**
`agenticLoop.ts:329-345` (`chunk.choices as Array<...>`, `chunk.usage as ...`), `parseSSE.ts:33-37`, `buildAISystemPrompt.ts:155-170`. Streamed chunks are blind-cast; a provider returning `choices: null` on an error chunk throws `TypeError` mid-generator, surfacing as an opaque error frame. `parseSSE` silently drops malformed `data:` lines and a stream truncated before `[DONE]` ends the turn as a normal `finishReason: 'stop'` — truncated answers are indistinguishable from complete ones. The `(cfg as any)` casts for `kpiTrend`/`gridSortField`/etc. are stale — those keys already exist on the local `StudioWidgetConfig` type, so the casts only disable typo checking. Fix: add a runtime guard (`Array.isArray(chunk.choices)`) before use; track whether a `finish_reason` was ever seen and emit a distinguishable `finishReason: 'truncated'` otherwise; delete the stale `as any` casts.

**The highest-leverage single move is the shared pure-TS protocol/model package (findings 2-4 collapse into it); the highest-urgency bug fixes are findings 1, 6, and 7.**
