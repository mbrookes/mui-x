# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Refer to @AGENTS.md for commands (linting, testing, TypeScript, docs) and coding conventions.
Refer to @AGENTS.local.md for personal workflow preferences.

## Repository overview

MUI X is a pnpm monorepo managed with Lerna. Public packages live under `packages/` and are published as `@mui/x-*`. The `examples/` directory holds standalone Vite/React apps that are **never published**.

Key packages:

- `x-data-grid` / `-pro` / `-premium` — Data Grid (MIT/commercial)
- `x-charts` / `-pro` / `-premium` — Charts (MIT/commercial)
- `x-date-pickers` / `-pro` — Date & Time Pickers
- `x-tree-view` / `-pro` — Tree View
- `x-scheduler` / `-pro` / `-premium` — Scheduler (commercial)
- `x-chat` — AI chat component
- `x-studio` — Embedded analytics studio (**not published**, breaking changes OK)
- `x-studio-ai-middleware` — Framework-agnostic server handler for AI chat
- `x-studio-data-middleware` — Framework-agnostic server handler for DB queries
- `x-internals` — Shared primitives (Store, hooks) consumed by the packages above
- `x-codemod` — Jscodeshift codemods for consumers migrating between versions

## x-studio architecture

x-studio is an embedded analytics dashboard builder. Understanding the layered architecture is essential when working on it.

### State management

`StudioController` (`packages/x-studio/src/store/StudioController.ts`) owns all mutable state via `Store<StudioState>` from `@mui/x-internals/store`. `Store<T>` is a minimal observable (subscribe/setState/getSnapshot) compatible with `useSyncExternalStore`. `StudioController` adds undo/redo stacks and all imperative mutation methods.

`StudioState` (`packages/x-studio-schema/src/stateTypes.ts` — the shared, zero-dependency schema package; `x-studio/src/models/stateTypes.ts` is a thin re-export shim for existing deep imports) is partitioned by lifetime into three top-level fields:

- `doc: StudioDoc` — the user-authored dashboard document, and the ONLY partition that is persisted, undoable, and mutated by the shared `applyMutation` reducer: `dashboard` (title, date range, theme), `pages`, `widgets` (flat, not nested per-page), `relationships`, `filters` (including cross-filter entries — those live here, not in `session`, because the reducer manipulates them and `applyCrossFilter` is deliberately undoable; they're stripped only at the persistence boundary), `expressionFields`, `filterPresets?`, `ai?` (chat thread state).
- `session: StudioSession` — ephemeral UI state, never persisted, never undoable, never touched by the reducer: `mode` (view/edit — deliberately not in `doc`, since switching modes isn't a dashboard edit) and `shell` (open drawers, selection).
- `runtime: StudioRuntime` — host-injected state, never persisted, never undoable, never touched by the reducer: `dataSources` (row data is never persisted or undone, since an undo must not revert live data to stale rows).

`StudioController`'s undo/redo stacks snapshot `StudioDoc[]` only — session and runtime changes are never pushed onto them.

### React integration

`StudioProvider` (`src/context/StudioContext.tsx`) wraps `StudioController` in React context. Components access the controller via `useStudioController()` and subscribe to slices of state via `useStudioSelector(selector)` (built on `useSyncExternalStore`).

`Studio` (`src/components/Studio/Studio.tsx`) is the top-level public component. It creates a `StudioController`, wraps children in `StudioProvider` + `StudioUIConfigContext`, and exposes an imperative `StudioHandle` ref (undo/redo, setMode, serializeState, etc.).

### Data pipeline

The row pipeline has four ordered, separately-cached layers. `StudioPipeline` (`src/internals/StudioPipeline.ts`) is the non-React façade over L2–L4:

1. **L1** — normalize raw `dataSources[id].rows` (`internals/normalizedRowsCache.ts`); every other layer and the adapter path must go through it
2. **L2** — enrich rows with expression-column (computed field) values
3. **L3** — apply scoped filters (page / widget / cross-filter / interactive)
4. **L4** — re-anchor to chart aggregation grain (for multi-source chart fields)

Widget components call `resolveWidgetRows()` then apply widget-specific aggregation themselves.

### State persistence

`statePersistence.ts` (`packages/x-studio-schema/src/statePersistence.ts`) handles serialization of the `doc` partition only — `serializeState`/`serializeDoc` take a `StudioDoc` (or the `doc` field of a `StudioState`); `session` and `runtime` are never serialized (session state resets to defaults and runtime data sources are re-injected by the host on load). `CURRENT_SCHEMA_VERSION` is an integer defined in `stateTypes.ts` (the single source of truth) and re-exported from `statePersistence.ts`; add a migration entry keyed by the **old** version when bumping. The `migrateState` function runs migrations sequentially.

### Widget system

Seven built-in widget kinds live in `src/components/widgets/`: Chart, Grid, KPI, Map, Pivot, Text, Filter. Custom widgets can be registered via `StudioProvider.customWidgets`. Each widget kind has an optional `setupPanel` for the compose drawer UI.

### Middleware packages (server-side)

Both middleware packages export a single pure framework-agnostic handler:

- `x-studio-ai-middleware`: `handleAIChat(body, opts)` — runs the agentic LLM loop, streams SSE back
- `x-studio-data-middleware`: `handleBatchQuery(body, opts)` — validates tables, queries DB via Knex, returns JSON

Neither package imports any HTTP framework. The host app parses the request, calls the handler, and writes the result.

## Running examples

```bash
# x-studio example (main dev app)
cd examples/x-studio && pnpm dev        # Vite dev server (client)
cd examples/x-studio && pnpm server     # Express API server (AI + data middleware)

# Other examples are also Vite apps:
cd examples/<name> && pnpm dev
```

## Adding a new widget type

1. Add the kind string to `BuiltinStudioWidgetKind` in `packages/x-studio-schema/src/baseTypes.ts` (`StudioWidgetKind` is the open union `BuiltinStudioWidgetKind | (string & {})`, and `x-studio/src/models/baseTypes.ts` is only a re-export shim)
2. Create a directory under `src/components/widgets/Studio<Kind>Widget/`
3. Add the widget component and an optional setup panel
4. Register the kind in the widget factory / compose drawer

> Custom charts stay app-level: compose the public `@mui/x-charts*` APIs inside an x-studio widget — never patch a new chart type into the shipping `x-charts*` packages. See the "x-studio custom charts" section of `AGENTS.md` for the rationale (BL-182).

## Schema migrations

When changing `StudioDoc` (the persisted partition of `StudioState`) in a way that breaks deserialization of persisted dashboards:

1. Increment `CURRENT_SCHEMA_VERSION` in `packages/x-studio-schema/src/stateTypes.ts` (the single source of truth; `statePersistence.ts` re-exports it)
2. Add a migration function keyed by the **previous** version number
3. Add a test in `statePersistence.test.ts` with a v(N) fixture

## Docs reference

Local LLM-optimized docs for each public package live at `docs/public/x/<package>/llms.txt`. Always consult these before relying on training data — the in-repo implementation may differ from pre-training snapshots.
