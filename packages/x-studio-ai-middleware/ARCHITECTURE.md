# Architecture

Internal reference for how `@mui/x-studio-ai-middleware` is put together. For install/quick-start, see [`README.md`](./README.md).

## Overview

This package is a framework-agnostic, pure-function server-side handler for the MUI X Studio AI assistant. It has no HTTP framework dependency and no LLM vendor SDK — every model call goes through raw `fetch` against an **OpenAI-compatible chat-completions endpoint** (`stream: true`, tool calling via `tools`/`tool_choice`), so any provider reachable through an OpenAI-compatible gateway/proxy works, including non-OpenAI models fronted by one.

Two independent surfaces share the same core tool logic:

- **Chat (SSE)**: `handleAIChat` → `runAgenticLoop` — a streaming, multi-turn agentic loop driven by the LLM.
- **MCP**: `buildStudioMcpServer` — exposes the same tools/state directly to any MCP client (e.g. an IDE agent), independent of the chat loop.

Both dispatch state-mutating tool calls through the same `executeToolOnState` function, which in turn delegates the actual state transformation to `applyMutation` — a pure reducer shared with the client via `@mui/x-studio-schema`. That reducer is the single source of truth for what a tool call does to `StudioState`; both transports (and the browser client) compute identical results from identical inputs.

Runtime dependency: `@mui/x-studio-schema` (workspace package — the shared, zero-dependency data model and mutation reducer). Dev-only dependencies: `@mui/x-chat-headless` (only for the `ChatMessage` type) and `@modelcontextprotocol/sdk` (needed only if the host uses `buildStudioMcpServer`).

## Public API surface (`src/index.ts`)

- Chat handler: `handleAIChat` (+ `StudioAIHandlerOptions`, `StudioAIContextEnricher(Args)`)
- Non-streaming handlers: `handleGenerateTitle`, `handleCreateWidget` (from `handleGenerateInsight.ts`)
- Protocol types: `StudioAIRequest`, `StudioAISSEEvent`, `StudioAISkill`, `SkillExecuteResult`, `SerializableSkill`, `StateMutation`, `StudioAIToolName`, `StudioDataResolver(Result)`, rate-limit/usage/rich-context types
- Prompt/tools: `buildAISystemPrompt`, `serializeFieldForAI`, `buildPageLayoutContext`, `STUDIO_AI_TOOLS`, `WIDGET_CONFIG_DESCRIPTION`
- Built-in skills: `dashboardNarratorSkill`, `insightSuggestorSkill` — these are the only two skills defined in `studioSkills.ts`; both are `instruction-only` (no callable tool)
- `generateFieldDescriptions`, `renderChartSvg`, `createDefaultWidget`
- Lower-level primitives for custom loops: `runAgenticLoop`, `executeToolOnState`
- MCP: `buildStudioMcpServer` + associated types, `createDefaultStudioState`

## Module map

| Path                           | Responsibility                                                                                                                                                                                                                                                                               |
| :----------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handleAIChat.ts`              | Top-level SSE handler — wraps `runAgenticLoop` in a `ReadableStream`, encodes each event as SSE, links an internal `AbortController` to consumer cancellation                                                                                                                                |
| `agenticLoop.ts`               | `runAgenticLoop` — the core multi-turn agentic loop (async generator)                                                                                                                                                                                                                        |
| `executeToolOnState.ts`        | Pure `(toolName, args, state) → { output, mutation?, nextState }` for all built-in tools; builds a `StateMutation` and calls `applyMutation` from `@mui/x-studio-schema`                                                                                                                     |
| `studioAITools.ts`             | `STUDIO_AI_TOOLS` — OpenAI-compatible tool/function schemas for all built-in tools, plus a compile-time drift guard against `StudioAIToolName`                                                                                                                                               |
| `studioSkills.ts`              | `dashboardNarratorSkill`, `insightSuggestorSkill` — prompt-only instruction fragments                                                                                                                                                                                                        |
| `buildAISystemPrompt.ts`       | Composes the full system prompt from static instructions + dashboard state + skills + rich/enriched context                                                                                                                                                                                  |
| `buildPageLayoutContext.ts`    | Pure structural extraction of the active page's widget layout + cross-filter graph (no row data needed)                                                                                                                                                                                      |
| `mcp.ts`                       | `buildStudioMcpServer` — the MCP composition root; wires the `mcp/` submodules into a `Server`                                                                                                                                                                                               |
| `mcp/types.ts`                 | Public MCP types: `StudioMcpOptions`, `StudioStateBox`, `StudioDataQueryParams/Result`, filter/aggregation/order-by/having types                                                                                                                                                             |
| `mcp/helpers.ts`               | `errorResult`/`jsonResult` `CallToolResult` builders, `withTimeout`, the `ToolHandler` dispatch type                                                                                                                                                                                         |
| `mcp/toolMetadata.ts`          | Static data: `TOOL_TITLES`, `TOOL_ANNOTATIONS`, `QUERY_DATA_SOURCE_SCHEMA`, `DATA_TOOL_DEFINITIONS`, `EXTRA_TOOL_DEFINITIONS`                                                                                                                                                                |
| `mcp/dataTools.ts`             | Handlers for `query_data_source`, `describe_data_source`, `get_field_values`, `compute_field_stats`, `render_chart`, `get_recent_changes`, and `summarise_page` (when `data` is configured)                                                                                                  |
| `mcp/resources.ts`             | `resources/list`, `resources/read`, `resources/subscribe`, `resources/unsubscribe` handlers                                                                                                                                                                                                  |
| `mcp/prompts.ts`               | `prompts/list`, `prompts/get` (`query_data_source_examples`), and `completion/complete` (URI/argument autocomplete)                                                                                                                                                                          |
| `chartRenderer.ts`             | `renderChartSvg` — dependency-free SVG chart generator (bar/line/pie/scatter/donut/stacked_bar)                                                                                                                                                                                              |
| `generateFieldDescriptions.ts` | One-shot LLM call to generate `aiDescription` text for a data source's fields                                                                                                                                                                                                                |
| `parseSSE.ts`                  | Minimal OpenAI-compatible SSE stream parser used by `agenticLoop.ts`                                                                                                                                                                                                                         |
| `handleGenerateInsight.ts`     | `handleGenerateTitle`, `handleCreateWidget` — non-streaming, non-agentic one-shot LLM calls                                                                                                                                                                                                  |
| `widgetConfigMeta.ts`          | Single source of truth for widget-kind docs shown to the LLM (tool schemas + system prompt)                                                                                                                                                                                                  |
| `widgetFactory.ts`             | Re-export shim: `createDefaultWidget` now lives in `@mui/x-studio-schema`, re-exported via `models/studioTypes.ts`                                                                                                                                                                           |
| `models/aiTypes.ts`            | Re-exports the shared protocol types from `@mui/x-studio-schema` (`SerializableSkill`, `StateMutation`, `StudioAIToolName`, rich-context types) and defines the server-only types (`StudioAISkill`, `SkillExecuteResult`, `StudioDataResolver`, rate-limit/usage, `StudioAIEnrichedContext`) |
| `models/protocol.ts`           | Wire protocol: `StudioAIRequest`, `StudioAISSEEvent`                                                                                                                                                                                                                                         |
| `models/studioTypes.ts`        | Thin re-export of `@mui/x-studio-schema` (`StudioState`, widgets, sources, filters, `createDefaultStudioState`/`createDefaultWidget`), plus the server-local `StudioCustomWidgetDef` (a React-free subset of the client's type)                                                              |

## Shared schema dependency: `@mui/x-studio-schema`

`@mui/x-studio-schema` (`packages/x-studio-schema`) is a separate workspace package with **zero runtime dependencies** — no React, no Node built-ins — importable from both a browser bundle (`@mui/x-studio`) and this server package. It is the single place the `StudioState` shape and its associated pure logic live, so the client and the AI middleware share one definition instead of maintaining independent copies.

It exports:

- All `StudioState` data-model types: `baseTypes.ts`, `dataTypes.ts`, `widgetTypes.ts`, `expressionTypes.ts`, `stateTypes.ts`
- AI-protocol types (`aiTypes.ts`): `SerializableSkill`, `StateMutation`, `StudioAIToolName`, `StudioAIRichContext` and its constituent types (`StudioAIFieldStat`, `StudioAILayoutWidget`, `StudioAICrossFilterEdge`, `StudioAIPageLayout`, `StudioAIRecentMutation`), and the persisted `StudioAIState`/`StudioAIChatThread` conversation types
- `createDefaultWidget` (`factories.ts`) — shared so AI-created and UI-created widgets get identical defaults
- `detectAnomaliesIQR` (`anomalyDetection.ts`) — the Tukey-IQR outlier check used by `summarise_page`'s time-series anomaly detection, on both the client and the MCP `summarise_page` handler
- `applyMutation`, `mutationLabel` (`applyMutation.ts`) — see below

Server-only AI types (`StudioAISkill` with its `execute` function, `SkillExecuteResult`, `StudioDataResolver`, rate-limit/usage/enriched-context types) are **not** part of the shared schema — they live in this package's `models/aiTypes.ts` since the client never needs them.

`packages/x-studio-ai-middleware/src/models/studioTypes.ts` and `widgetFactory.ts` are now thin re-export shims over `@mui/x-studio-schema`; they exist only so pre-existing internal import paths (`./models/studioTypes`) keep working without a repo-wide rename.

### `applyMutation` — the single mutation reducer

`applyMutation(state: StudioState, mutation: StateMutation): StudioState` (`packages/x-studio-schema/src/applyMutation.ts`) is a pure reducer dispatched through a `MUTATION_HANDLERS` table keyed by `mutation.type`, covering every `StateMutation` variant (`addPage`, `setDashboardTitle`, `addWidget`, `updateWidget`, `removeWidget`, `setWidgetLayout`, `setWidgetColSpan`, `renamePage`, `removePage`, `setActivePage`, `addFilter`, `removeFilter`, `applyBulkUpdate`, `renameAIThread`). Each entry co-locates its `apply` (state transition) and `label` (human-readable log line) logic, so the two can never drift apart; the table's mapped type (`{ [M in StateMutation as M['type']]: ... }`) makes a variant missing a handler a compile error. At runtime, an unrecognized `mutation.type` (a malformed or forward-incompatible payload) is a graceful no-op rather than a throw.

Both transports use this same function for the state-transformation step:

- `executeToolOnState.ts` computes `nextState = applyMutation(state, mutation)` on the server, threading it across tool calls in the same turn and, for MCP, across the whole `StudioStateBox` session.
- The client applies the identical function inside `StudioController.applyExternalMutation` when a `state-mutation` SSE event arrives.

Notable semantics baked into the reducer:

- `removePage` performs full cleanup matching `StudioController.removePage`: it drops the page, removes every widget that lived on it, drops page-scoped filters that targeted it, and reassigns `dashboard.activePageId` to another remaining page (or `''`) when the removed page was active.
- `removeWidget` drops the widget from every page's `widgetRows` (removing now-empty rows) and drops filters that only made sense while the widget existed (its own widget-scoped filters, and interactive cross-filters it emitted).
- `addWidget` takes an explicit, server-chosen target `pageId` in `mutation.args` (falling back to the applying side's active page only for legacy payloads without one) — this guarantees the widget lands on the same page the model was told about, even if the client navigates to a different page while the model is "thinking".
- `addFilter` applies the filter verbatim, without re-stamping its scope to the applying side's active page — the filter already carries its target page/widget, chosen server-side.
- Side effects a pure reducer cannot own — undo-stack management, title inference from live data sources, React shell selection — are intentionally **not** performed here; they stay in `StudioController` on the client.

`mutationLabel(mutation)` produces a compact human-readable label (e.g. `addWidget:chart:widget-123`, `removeFilter:filter-9`) used for the AI recent-mutation log surfaced in the system prompt's `<dashboard_context>` block and MCP's `get_recent_changes` tool.

## Core data flow: chat request lifecycle

1. Host app parses the request body into a `StudioAIRequest` and calls `handleAIChat(body, options)`, getting back a `ReadableStream<string>` to pipe as `text/event-stream`.
2. `handleAIChat` creates an internal `AbortController` linked to any host-supplied `options.signal` **and** to the `ReadableStream`'s own `cancel()` callback, so a consumer calling `reader.cancel()` propagates into the agentic loop exactly like a host-triggered abort.
3. Inside the stream's `start`, `handleAIChat` best-effort runs `options.contextEnricher` (skipped if `privateMode`; failures are non-fatal, reported via `onToolError('contextEnricher', err)`), then calls `runAgenticLoop`.
4. `runAgenticLoop` builds the system prompt once (`buildAISystemPrompt`, folding in skills/richContext/enrichedContext), computes the effective tool list (`STUDIO_AI_TOOLS` filtered by `allowedTools`, gated by `dataResolver`/`pageSnapshot` presence, plus any `server-tool`-mode skill schemas), and converts the `ChatMessage[]` history to OpenAI-style messages.
5. For each turn (max 10 by default, or `rateLimit.maxTurnsPerRequest`): POST to `options.endpoint` with `stream: true`; consume the response via `parseSSE`; yield `text-delta` events as they arrive; accumulate tool-call fragments keyed by index (falling back to a per-`id` synthetic index when a provider's deltas carry an `id` but never an `index`).
6. **No tool calls** → yield `message-metadata`, `usage`, `finish`, generator returns (conversation done). **Tool calls present** → each is dispatched in order:
   - Malformed tool-call arguments (invalid JSON in the streamed `arguments` buffer) are _not_ silently coerced to `{}` and executed — the loop feeds the parse failure back to the model as a tool error so it can retry with valid JSON, without ever running a destructive tool against wrong (empty) args.
   - A matching `server-tool` skill handler (`skillHandlers`) is invoked, sync or async; its `mutation`/`nextState` flow through the loop the same way a built-in tool's does.
   - `execute_query` → `dataResolver.resolve()`, or a descriptive error if no resolver was configured.
   - A skill tool declared in `body.skills` but with no matching entry in `skillHandlers` → a descriptive "no registered handler on the server" error.
   - A destructive tool (`remove_page`, `remove_widget`, `apply_bulk_update`) with `approvalPending` configured → yields `tool-approval-request` and pauses. The pause is a `Promise.race` between: the approval callback resolving (client approved/denied), `approvalTimeoutMs` elapsing (default 120s), or the abort signal firing — never a bare unconditional await. On timeout the model is told `{denied: true, reason: 'approval timed out'}`; on abort the generator returns silently; the `approvalPending` map entry is always deleted in a `finally`, so an abandoned approval prompt cannot leak the entry or hang the SSE stream forever.
   - Otherwise, `executeToolOnState(toolName, args, currentState, customWidgets, pageSnapshot)` runs; its `nextState` becomes `currentState` for the rest of the turn and any subsequent turns.
   - Each call yields `tool-activity` (`start` then `complete`) and, if it produced a mutation, `state-mutation`; results are appended to the OpenAI message history and the loop continues to the next turn.
7. Token budget exceeded (`usage.inputTokens + usage.outputTokens >= rateLimit.maxTokensPerRequest`) or `maxTurns` exhausted → `rateLimit.onLimitReached('tokens' | 'turns', usage)` then an `error` SSE event. An `AbortSignal` firing at any point (fetch, SSE read, or approval wait) → silent return, no `error` event.
8. `handleAIChat` encodes each yielded `StudioAISSEEvent` as `data: ${JSON.stringify(event)}\n\n`, breaking the forwarding loop on `finish`/`error`; the stream always closes in a `finally`, and the top-level `try/catch` guards `controller.enqueue` against throwing if the consumer already cancelled the stream.
9. The browser client applies `state-mutation` events to its own `StudioController` and renders `text-delta`/`tool-activity`/`tool-approval-request` events live.

## Tool execution / state mutation model

`executeToolOnState(toolName, input, state, customWidgets?, pageSnapshot?)` (`executeToolOnState.ts`) is a pure function: `(toolName, args, state) → { output, mutation?, nextState }`. For every write tool it follows the same shape:

1. Validate the referenced entity exists (widget/page/filter) — e.g. `update_widget`, `remove_widget`, `rename_page`, `remove_page`, `set_active_page`, and `set_widget_forecast` all look up the target in `state` first and return a JSON `{ error }` output with `nextState: state` (a no-op) if it's missing, rather than building a mutation against a nonexistent entity.
2. Build a `StateMutation` value describing the intended change.
3. Call `applyMutation(state, mutation)` from `@mui/x-studio-schema` to compute `nextState`.
4. Return `{ output: JSON.stringify(...), mutation, nextState }`.

Tools without side effects (`get_dashboard_state`, `list_pages`) skip steps 2–3 and return `nextState: state` unchanged. `get_dashboard_state` returns the raw `StudioState` object as its JSON output — this is the canonical contract shared with the MCP transport (`mcp.ts`'s `get_dashboard_state` handler returns the same raw state), so the tool means the same thing on both surfaces; the full rendered system prompt is already the chat request's system message, so re-emitting it as tool output would be redundant.

Notable per-tool behavior:

- **`add_widget`** resolves the target page as `state.dashboard.activePageId` server-side and errors (`"there is no active page"`) rather than spreading an undefined page into state if there isn't one. Config is layered: widget-kind defaults (`createDefaultWidget`) → any matching `customWidgets[].defaultConfig` → the model-supplied `config` (highest priority).
- **`apply_bulk_update`** is a single atomic operation: it applies removals, then additions, then partial updates, then an optional full-page relayout (widget references in `layout` may be given by the newly-added widget's `title`, resolved to its generated id), then column-span patches (clamped to 3–12), building one `applyBulkUpdate` mutation for the whole batch. Skipped operations (referencing an unknown widget id) are collected into a `skipped` array in the output rather than throwing.
- **`summarise_page`** behaves differently depending on transport: on the chat path it can only honor the _active_ page (only the client-provided `pageSnapshot` has live row data, and that snapshot is built for the active page) — if the model passes a `pageId` for a non-active page, the tool returns an actionable error telling it to call `set_active_page` first. On the MCP path (`mcp/dataTools.ts`'s `createSummarisePageHandler`), the server can query any page's sources directly via `data.queryDataSource`, so a `pageId` argument is honored without switching pages.
- **`set_widget_forecast`** validates that the target widget's `chartType` is `line` or `area` before accepting the change, since forecast overlays are meaningless otherwise.
- **`rename_thread`** builds a `renameAIThread` mutation, stamping `args.updatedAt` once here (`new Date().toISOString()`) so the server-computed and client-applied results share the identical timestamp — the reducer itself never calls `Date.now()`, keeping it pure. The mutation is for the client to apply to `state.ai`; since the server-side `StudioState` carries no `ai` thread store, `applyMutation` for this case is effectively a no-op on the server's own copy — only the client's application of the same mutation actually renames the thread.

## MCP surface

`mcp.ts` is a slim (~300-line) **composition root**: it creates the MCP `Server`, owns the session-scoped mutable state (the boxed `StudioState`, the `recentChanges` log, the `subscribedUris` set), and wires together the handler modules extracted into `mcp/`.

`buildStudioMcpServer(stateBox, options?)` uses a **boxed mutable state** (`{ current: StudioState }`, type `StudioStateBox`) shared across tool calls in an MCP session — using a box lets every registered handler share one mutable pointer, so writing `stateBox.current = result.nextState` after a mutation makes the next tool call in the same session see the update automatically.

It registers:

- **`tools/list` + `tools/call`** — re-exposes `STUDIO_AI_TOOLS` (minus `execute_query` by default, since it runs raw SQL against a live DB connection and isn't safe to expose without explicit opt-in via `allowedTools`), plus, when `options.data` is supplied, the read-only data tools (`query_data_source`, `describe_data_source`, `get_field_values`, `compute_field_stats` — defined in `mcp/toolMetadata.ts`'s `DATA_TOOL_DEFINITIONS`, handlers in `mcp/dataTools.ts`), and unconditionally `render_chart` and `get_recent_changes` (`mcp/toolMetadata.ts`'s `EXTRA_TOOL_DEFINITIONS`). Special-cased tools are looked up in a `Record<string, ToolHandler>` dispatch table (`toolHandlers`) built from `get_dashboard_state` plus `createDataToolHandlers(...)`; everything else falls through to the shared `executeToolOnState` mutation path, so registering a new data tool is a table entry rather than a branch in a growing if-chain.
- State-mutating calls (the fallthrough path) go through `executeToolOnState`, write `nextState` back into `stateBox.current`, append a `mutationLabel(mutation)` entry to the session's `recentChanges` log (capped at 20, oldest evicted first), notify any subscribed resource URIs via `server.sendResourceUpdated`, and call `options.onStateChange?.(stateBox.current)` so the host can persist the session.
- **`resources/*`** (`mcp/resources.ts`) — `studio://dashboard/state` (raw `StudioState` JSON), `studio://dashboard/system-prompt` (the AI system prompt built from current state, with `contextEnricher` support analogous to the chat path's), `studio://dashboard/data-health` (per-source row counts, only when `data` is configured), `studio://schema/{sourceId}` (field metadata), `studio://data/{sourceId}` (up to 20-row preview, only when `data` is configured) — with subscribe/unsubscribe support and completion-based URI autocomplete.
- **`prompts/*`** (`mcp/prompts.ts`) — one built-in prompt, `query_data_source_examples`, which generates example `query_data_source` invocations (a count-by-category and a sum-by-category query) tailored to the dashboard's actual configured data sources, plus `sourceId` argument autocomplete.

`summarise_page` on the MCP path (`mcp/dataTools.ts`'s `createSummarisePageHandler`) is richer than the chat path's: when `options.data` is configured it queries live rows per widget, computes numeric stats and a CSV excerpt, and — for time-series chart widgets — runs a GROUP BY aggregation query plus `detectAnomaliesIQR` (imported from `@mui/x-studio-schema`) to flag anomalous periods (trimming the first/last bucket, which are commonly partial periods and produce false-positive low outliers). The period-truncation helpers (`mcpTruncateToPeriod`, `mcpIsoWeek`) remain local to `mcp/dataTools.ts` — they mirror the client's `temporalUtils.ts` truncation logic (including its numeric-timestamp fallback) but are not shared via the schema package, since the client file they live in also pulls in unrelated pipeline code.

## Skills

`studioSkills.ts` defines exactly two built-in skills, both `mode: 'instruction-only'` (a prompt fragment with no callable tool — the model reads `<dashboard_state>` and composes a plain-text response):

- **`dashboardNarratorSkill`** — triggers on "walk me through", "explain", "describe", or "give an overview of" the dashboard. Produces a business-stakeholder-friendly narrative: purpose, each widget by title/type, active filters, and a closing summary sentence.
- **`insightSuggestorSkill`** — triggers on "what's interesting?", "any insights?", requests for notable/unusual observations. Suggests 2–4 specific, numbered observations grounded in the actual widgets/fields present, ending with a note on what additional data could deepen the analysis.

Apps can register additional skills of any `StudioAISkill` mode (`instruction-only`, `server-tool` with an `execute` function, or `client-handler`) by passing them through `StudioAIConfig.skills` (serialized as `SerializableSkill` over the wire) and, for `server-tool` skills, through `StudioAIHandlerOptions.skillHandlers` so the agentic loop can invoke `execute` server-side when the model calls the skill's tool.

## Tool registry: `STUDIO_AI_TOOLS`

`studioAITools.ts` declares `STUDIO_AI_TOOLS` as a single `as const` array of OpenAI-compatible `{ type: 'function', function: { name, description, parameters } }` entries — the same array is passed as the `tools` field of every chat-completion request and re-exposed (mapped into MCP's `Tool` shape) by `buildStudioMcpServer`'s `tools/list` handler. There is exactly one registry; both transports read from it, so adding a tool is a one-file change (`studioAITools.ts` + a case in `executeToolOnState.ts`) to be available everywhere.

`STUDIO_AI_TOOL_NAMES` is the array of registered names, derived at runtime from `STUDIO_AI_TOOLS`. `StudioAIToolName` (the type consumers use for `allowedTools`) lives in `@mui/x-studio-schema` rather than being derived from `STUDIO_AI_TOOLS` directly — deriving it here would invert the schema package's dependency direction (the client needs `StudioAIToolName` without depending on this server package). Instead, `studioAITools.ts` ends with a compile-time mutual-assignability check (`AssertMutuallyAssignable<AdvertisedToolName, StudioAIToolName>`) asserting the hand-maintained union in the schema package exactly matches the tool names actually advertised in `STUDIO_AI_TOOLS` — adding a tool to one without the other is now a TypeScript compile error rather than a silent drift.

Per-transport tool availability differs by design, not by accident:

- **`execute_query`** — advertised in the chat loop only when `options.dataResolver` is configured; registered in MCP only when explicitly listed in `allowedTools` (excluded by default via `DEFAULT_EXCLUDED_TOOLS`), since it runs arbitrary queries against a live DB connection.
- **`summarise_page`** — advertised in the chat loop only when a `pageSnapshot` was provided (or the host explicitly opts in via `allowedTools`), because live row data is otherwise only available client-side. In MCP it is unconditionally listed, but its handler only queries live data when `options.data` is configured — without `data` it falls through to `executeToolOnState`, which returns a descriptive client-side-limitation error.
- **`get_dashboard_state`** and **`summarise_page`**'s _output contracts_ are aligned across transports (both return the raw `StudioState` / the same snapshot text), but their _availability gating_ intentionally differs per the constraints above — this is a deliberate contract difference between the chat and MCP surfaces, not a bug.

## Key design invariants

1. **Pure function / dependency injection** — no framework imports, no globals; endpoint, apiKey, callbacks, and abort signal are all passed as options. Don't add a hard HTTP framework or vendor SDK dependency here.
2. **Immutable state threading** — `StudioState` is never mutated in place; every tool call returns a new `nextState` (via `applyMutation`), threaded through subsequent tool calls in the same turn and across an MCP session via `StudioStateBox`.
3. **One core, two transports** — `executeToolOnState`, `STUDIO_AI_TOOLS`, `applyMutation`, and `buildAISystemPrompt` are shared verbatim between the chat loop and the MCP server. Adding or changing a tool means editing `executeToolOnState.ts` + `studioAITools.ts` once, not per-transport.
4. **Cacheable static prompt prefix** — `STUDIO_AI_INSTRUCTIONS` in `buildAISystemPrompt.ts` is a module-level constant so providers can prompt-cache it as a stable prefix; don't make it depend on request-specific data.
5. **Errors never abort the stream** — top-level exceptions become an `{type:'error'}` SSE event (stream still closes cleanly); per-tool exceptions are caught and surfaced to the model as `{error: message}` tool output so it can recover, rather than killing the loop.
6. **Best-effort enrichment** — `contextEnricher` failures are logged and swallowed; the chat proceeds without enrichment rather than failing the whole request.
7. **Bounded pauses, not indefinite waits** — the tool-approval pause in `agenticLoop.ts` always races the approval promise against an abort signal and a timeout, and always cleans up its `approvalPending` map entry, so an abandoned client can never leak server resources or hang a stream forever.
8. **Single semantic authority for mutations** — `applyMutation` in `@mui/x-studio-schema` is the one implementation of every `StateMutation`'s effect; the server-threaded state and the client-applied state cannot disagree because they run the same code, not hand-synced parallel implementations.

## Extension points

- **New built-in tool**: add a `StateMutation` variant (if it changes state) to `@mui/x-studio-schema`'s `StateMutation` union and a `case` in `applyMutation`, a case in `executeToolOnState.ts` that builds the mutation, a schema entry in `studioAITools.ts` (`STUDIO_AI_TOOLS`), and add the name to `StudioAIToolName` in `@mui/x-studio-schema` (the compile-time drift guard will fail otherwise) — and, if it needs LLM-facing docs, an entry in `widgetConfigMeta.ts`. It's then automatically available to both the chat loop and MCP.
- **New skill**: add a `StudioAISkill` to `studioSkills.ts` (`mode: 'instruction-only'` for a prompt fragment, or a callable `server-tool` skill with an `execute` function passed via `skillHandlers`).
- **New widget kind's AI-facing config**: update `widgetConfigMeta.ts` (`WIDGET_KIND_DESCRIPTIONS`, `KIND_CONFIG_LINES`) — this is the single place that keeps the `add_widget`/`update_widget` tool schemas and the system prompt's widget docs in sync.
- **Custom agentic loop**: `runAgenticLoop` and `executeToolOnState` are exported directly for hosts that want to build their own loop instead of using `handleAIChat`.

## Testing conventions

Two Vitest configs cover this package:

- `vitest.config.jsdom.mts` (`pnpm test:unit`) — `environment: 'jsdom'`, excludes `src/**/__tests__/**`. Covers all colocated `*.test.ts` files: `agenticLoop.test.ts`, `executeToolOnState.test.ts`, `mcp.test.ts`, `handleAIChat.test.ts`, `buildAISystemPrompt.test.ts`, `buildPageLayoutContext.test.ts`, `chartRenderer.test.ts`, `generateFieldDescriptions.test.ts`, `handleGenerateInsight.test.ts`, `parseSSE.test.ts`.
- `vitest.config.node.mts` (`pnpm test:integration`) — `environment: 'node'`, includes only `src/**/__tests__/**/*.test.ts`: `src/__tests__/mcp.integration.test.ts`, which exercises the MCP server end-to-end over the real `@modelcontextprotocol/sdk` `Server`/transport plumbing rather than calling request handlers directly.

`agenticLoop.test.ts` (~930 lines) is organized as one `describe` block per behavior under test, each mocking `global.fetch` to return a synthetic SSE stream:

- rate limiting (`usage` events, `maxTokensPerRequest`/`maxTurnsPerRequest` enforcement, cross-turn token accumulation)
- built-in tool gating (`summarise_page`/`execute_query` advertised only under the conditions described above)
- malformed tool-call arguments (invalid JSON fed back as an error, tool never executed)
- tool approval (timeout cleans up and reports `denied`, abort during the wait ends silently, an approved call executes and applies its mutation)
- server-tool skill execution (a registered skill's mutation is applied; a throwing skill is caught and reported via `onToolError`)
- `execute_query` execution (successful resolver result fed back; a rejected resolver caught and reported)
- unregistered skill fallback (a skill declared in the request but missing a server handler gets a descriptive error)
- tool-call delta accumulation fallback (streamed deltas that carry an `id` but never an `index`, for both a single tool call and two concurrent ones)

`executeToolOnState.test.ts` (~815 lines) has one `describe` block per tool (`get_dashboard_state`, `add_page`, `remove_page`, `add_widget`, `update_widget`, `remove_widget`, `set_widget_layout`, `set_widget_width`, filter tools, `apply_bulk_update`, `summarise_page`, `set_widget_forecast`, plus `unknown tool` and `nextState chaining` behavior), verifying both the JSON `output` contract and the resulting `nextState` (i.e., that `applyMutation` was invoked with the expected effect) for each.

`mcp.test.ts` (~815 lines, jsdom) drives `buildStudioMcpServer` by pulling registered request handlers directly off the constructed `Server` and invoking them — organized into `describe('buildStudioMcpServer', ...)` (tools/resources/tool-calls/prompts, mirroring the tool-by-tool coverage style of `executeToolOnState.test.ts`) and `describe('buildStudioMcpServer — context for MCP clients', ...)` (the `get_recent_changes` log and the system-prompt resource's cross-filter-graph content). `src/__tests__/mcp.integration.test.ts` (node) separately checks the same surface (`tools/list` shape, resource reads, tool-call mutation propagation, prompt retrieval) through the real MCP protocol machinery rather than direct handler calls.
