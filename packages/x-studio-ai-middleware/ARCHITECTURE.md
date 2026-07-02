# Architecture

Internal reference for how `@mui/x-studio-ai-middleware` is put together. For install/quick-start, see [`README.md`](./README.md).

## Overview

This package is a framework-agnostic, pure-function server-side handler for the MUI X Studio AI assistant. It has no HTTP framework dependency and no LLM vendor SDK — every model call goes through raw `fetch` against an **OpenAI-compatible chat-completions endpoint** (`stream: true`, tool calling via `tools`/`tool_choice`), so any provider reachable through an OpenAI-compatible gateway/proxy works, including non-OpenAI models fronted by one. Its only runtime dependency is `@mui/x-chat-headless` (for the `ChatMessage` type); `@modelcontextprotocol/sdk` is a dev dependency needed only if the host uses `buildStudioMcpServer`.

Two independent surfaces share the same core tool logic:

- **Chat (SSE)**: `handleAIChat` → `runAgenticLoop` — a streaming, multi-turn agentic loop driven by the LLM.
- **MCP**: `buildStudioMcpServer` — exposes the same tools/state directly to any MCP client (e.g. an IDE agent), independent of the chat loop.

Both dispatch state-mutating tool calls through the same `executeToolOnState` function — the single source of truth for tool semantics.

## Public API surface (`src/index.ts`)

- Chat handler: `handleAIChat` (+ `StudioAIHandlerOptions`, `StudioAIContextEnricher(Args)`)
- Non-streaming handlers: `handleGenerateTitle`, `handleCreateWidget` (from `handleGenerateInsight.ts`)
- Protocol types: `StudioAIRequest`, `StudioAISSEEvent`, `StudioAISkill`, `SkillExecuteResult`, `SerializableSkill`, `StateMutation`, `StudioAIToolName`, `StudioDataResolver(Result)`, rate-limit/usage/rich-context types
- Prompt/tools: `buildAISystemPrompt`, `serializeFieldForAI`, `buildPageLayoutContext`, `STUDIO_AI_TOOLS`, `WIDGET_CONFIG_DESCRIPTION`
- Built-in skills: `dashboardNarratorSkill`, `insightSuggestorSkill` (note: `dataAnalystSkill` and `pageExplorerSkill` also exist in `studioSkills.ts` but are not re-exported from the package root)
- `generateFieldDescriptions`, `renderChartSvg`, `createDefaultWidget`
- Lower-level primitives for custom loops: `runAgenticLoop`, `executeToolOnState`
- MCP: `buildStudioMcpServer` + associated types, `createDefaultStudioState`

## Module map

| Path                           | Responsibility                                                                                                                                               |
| :----------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `handleAIChat.ts`              | Top-level SSE handler — wraps `runAgenticLoop` in a `ReadableStream`, encodes each event as SSE                                                              |
| `agenticLoop.ts`               | `runAgenticLoop` — the core multi-turn agentic loop (async generator)                                                                                        |
| `executeToolOnState.ts`        | Pure `(toolName, args, state) → { output, mutation?, nextState }` for all ~19 built-in tools                                                                 |
| `studioAITools.ts`             | `STUDIO_AI_TOOLS` — OpenAI-compatible tool/function schemas for all built-in tools                                                                           |
| `studioSkills.ts`              | `StudioAISkill` definitions — prompt-only instruction fragments (`dashboardNarratorSkill`, `insightSuggestorSkill`, `dataAnalystSkill`, `pageExplorerSkill`) |
| `buildAISystemPrompt.ts`       | Composes the full system prompt from static instructions + dashboard state + skills + rich context                                                           |
| `buildPageLayoutContext.ts`    | Pure structural extraction of the active page's widget layout + cross-filter graph                                                                           |
| `mcp.ts`                       | `buildStudioMcpServer` — MCP server exposing the same tools/state as resources/tools/prompts                                                                 |
| `chartRenderer.ts`             | `renderChartSvg` — dependency-free SVG chart generator (bar/line/pie/scatter/donut/stacked_bar)                                                              |
| `generateFieldDescriptions.ts` | One-shot LLM call to generate `aiDescription` text for a data source's fields                                                                                |
| `parseSSE.ts`                  | Minimal OpenAI-compatible SSE stream parser used by `agenticLoop.ts`                                                                                         |
| `handleGenerateInsight.ts`     | `handleGenerateTitle`, `handleCreateWidget` — non-streaming, non-agentic one-shot LLM calls                                                                  |
| `widgetConfigMeta.ts`          | Single source of truth for widget-kind docs shown to the LLM (tool schemas + system prompt)                                                                  |
| `widgetFactory.ts`             | Re-export shim for `createDefaultWidget` (implementation lives in `models/studioTypes.ts`)                                                                   |
| `models/aiTypes.ts`            | AI protocol types: `StateMutation`, rich-context types, `StudioAISkill`, rate-limit/usage types                                                              |
| `models/protocol.ts`           | Wire protocol: `StudioAIRequest`, `StudioAISSEEvent`                                                                                                         |
| `models/studioTypes.ts`        | Local copy of the Studio data model (`StudioState`, widgets, sources, filters — React fields stripped) + `createDefaultStudioState`/`createDefaultWidget`    |

`models/*.ts` deliberately **duplicates** types from the `@mui/x-studio` client package rather than importing them, to keep this package dependency-free — the boundary is structural typing, not a shared import.

## Core data flow: chat request lifecycle

1. Host app parses the request body into a `StudioAIRequest` and calls `handleAIChat(body, options)`, getting back a `ReadableStream<string>` to pipe as `text/event-stream`.
2. Inside the stream's `start`, `handleAIChat` best-effort runs `options.contextEnricher` (skipped if `privateMode`; failures are non-fatal, reported via `onToolError('contextEnricher', err)`), then calls `runAgenticLoop`.
3. `runAgenticLoop` builds the system prompt once (`buildAISystemPrompt`, folding in skills/richContext/enrichedContext), computes the effective tool list (`STUDIO_AI_TOOLS` filtered by `allowedTools`, gated by `dataResolver`/`pageSnapshot` presence, plus any `server-tool`-mode skill schemas), and converts the `ChatMessage[]` history to OpenAI-style messages.
4. For each turn (max 10 by default): POST to `options.endpoint` with `stream: true`; consume the response via `parseSSE`; yield `text-delta` events as they arrive; accumulate tool-call fragments by index/id.
5. **No tool calls** → yield `message-metadata`, `usage`, `finish`, generator returns (conversation done). **Tool calls present** → each is dispatched in order: (a) a matching `server-tool` skill handler, (b) `execute_query` → `dataResolver.resolve()`, (c) an unregistered skill tool → descriptive error, (d) a destructive tool (`remove_page`, `remove_widget`, `apply_bulk_update`) with `approvalPending` configured → yields `tool-approval-request` and awaits external resolution, (e) otherwise `executeToolOnState`. Each call yields `tool-activity` and, if it mutated state, `state-mutation`; results are appended to the message history and the loop continues to the next turn.
6. Token budget exceeded or `maxTurns` exhausted → `onLimitReached('tokens' | 'turns', usage)` then an `error` event. `AbortSignal` firing → silent return, no error event.
7. `handleAIChat` encodes each yielded `StudioAISSEEvent` as `data: ${JSON.stringify(event)}\n\n`, stopping on `finish`/`error`; the stream always closes in `finally`.
8. The browser client applies `state-mutation` events to its own `StudioController` and renders `text-delta`/`tool-activity`/`tool-approval-request` events live.

## MCP surface

`buildStudioMcpServer(stateBox, options?)` uses a **boxed mutable state** (`{ current: StudioState }`) shared across tool calls in an MCP session. It registers:

- `tools/list` + `tools/call` — re-exposes `STUDIO_AI_TOOLS` (minus `execute_query` by default) plus, when `options.data` is supplied, read-only data tools (`query_data_source`, `describe_data_source`, `get_field_values`, `compute_field_stats`), `render_chart` (via `chartRenderer.ts`), and `get_recent_changes` (session-scoped, capped mutation log).
- State-mutating calls go through `executeToolOnState`, write `nextState` back into `stateBox.current`, and notify subscribed resource URIs.
- `resources/*` — `studio://dashboard/state`, `studio://dashboard/system-prompt`, `studio://dashboard/data-health`, `studio://schema/{sourceId}`, `studio://data/{sourceId}`, with subscribe/unsubscribe support.
- `prompts/*` — one built-in prompt (`query_data_source_examples`) plus URI/argument autocomplete.

Note: `mcp.ts`'s `summarise_page` implementation is richer than `executeToolOnState`'s — when `options.data` is configured it queries live rows and runs a **locally reimplemented** Tukey-IQR anomaly check (`mcpDetectAnomaliesIQR`), duplicated from `@mui/x-studio`'s `anomalyDetection.ts` because this package cannot import from the client package. Keep both in sync by hand if the algorithm changes.

## Key design invariants

1. **Pure function / dependency injection** — no framework imports, no globals; endpoint, apiKey, callbacks, and abort signal are all passed as options. Don't add a hard HTTP framework or vendor SDK dependency here.
2. **Immutable state threading** — `StudioState` is never mutated in place; every tool call returns a new `nextState`, threaded through subsequent tool calls in the same turn and across an MCP session via `StudioStateBox`.
3. **One core, two transports** — `executeToolOnState`, `STUDIO_AI_TOOLS`, and `buildAISystemPrompt` are shared verbatim between the chat loop and the MCP server. Adding or changing a tool means editing `executeToolOnState.ts` + `studioAITools.ts` once, not per-transport.
4. **Cacheable static prompt prefix** — `STUDIO_AI_INSTRUCTIONS` in `buildAISystemPrompt.ts` is a module-level constant so providers can prompt-cache it as a stable prefix; don't make it depend on request-specific data.
5. **Errors never abort the stream** — top-level exceptions become an `{type:'error'}` SSE event (stream still closes cleanly); per-tool exceptions are caught and surfaced to the model as `{error: message}` tool output so it can recover, rather than killing the loop.
6. **Best-effort enrichment** — `contextEnricher` failures are logged and swallowed; the chat proceeds without enrichment rather than failing the whole request.
7. **Structural-typing boundary with `@mui/x-studio`** — `models/*.ts` intentionally duplicates client types instead of importing them. Changing `StudioState` in the client package does not automatically flow here; update both.

## Extension points

- **New built-in tool**: add a case in `executeToolOnState.ts`, a schema entry in `studioAITools.ts` (`STUDIO_AI_TOOLS`), and — if it needs LLM-facing docs — an entry in `widgetConfigMeta.ts`. It's then automatically available to both the chat loop and MCP.
- **New skill**: add a `StudioAISkill` to `studioSkills.ts` (`mode: 'instruction-only'` for a prompt fragment, or a callable `server-tool` skill with an `execute` function passed via `skillHandlers`).
- **New widget kind's AI-facing config**: update `widgetConfigMeta.ts` (`WIDGET_KIND_DESCRIPTIONS`, `KIND_CONFIG_LINES`) — this is the single place that keeps the `add_widget`/`update_widget` tool schemas and the system prompt's widget docs in sync.
- **Custom agentic loop**: `runAgenticLoop` and `executeToolOnState` are exported directly for hosts that want to build their own loop instead of using `handleAIChat`.
