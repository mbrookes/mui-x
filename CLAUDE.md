# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Refer to @AGENTS.md for commands (linting, testing, TypeScript, docs) and coding conventions.
Refer to @AGENTS.local.md for personal workflow preferences.

## Repository overview

MUI X is a pnpm monorepo managed with Lerna. Public packages live under `packages/` and are published as `@mui/x-*`. The `examples/` directory holds standalone Vite/React apps that are **never published**.

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

`StudioState` (`src/models/stateTypes.ts`) contains:

- `dashboard` — global settings (title, date range, theme)
- `pages` — record of `StudioPage` by ID
- `widgets` — record of `StudioWidget` by ID (flat, not nested per-page)
- `filters` — array of `StudioFilterState`
- `dataSources` — record of `StudioDataSource` (data never persisted)
- `relationships` — join definitions across sources
- `expressionFields` — computed column definitions
- `ai` — chat thread state

### React integration

`StudioProvider` (`src/context/StudioContext.tsx`) wraps `StudioController` in React context. Components access the controller via `useStudioController()` and subscribe to slices of state via `useStudioSelector(selector)` (built on `useSyncExternalStore`).

`Studio` (`src/components/Studio/Studio.tsx`) is the top-level public component. It creates a `StudioController`, wraps children in `StudioProvider` + `StudioUIConfigContext`, and exposes an imperative `StudioHandle` ref (undo/redo, setMode, serializeState, etc.).

### Data pipeline

`StudioPipeline` (`src/internals/StudioPipeline.ts`) processes raw rows through four ordered layers:

1. **L1** — resolve metric-ref filter values
2. **L2** — enrich rows with expression-column (computed field) values
3. **L3** — apply scoped filters (page / widget / cross-filter / interactive)
4. **L4** — re-anchor to chart aggregation grain (for multi-source chart fields)

Widget components call `resolveWidgetRows()` then apply widget-specific aggregation themselves.

### State persistence

`statePersistence.ts` (`src/store/statePersistence.ts`) handles serialization. Only the user-authored config is persisted (data sources are runtime-injected). `CURRENT_SCHEMA_VERSION` is an integer; add a migration entry keyed by the **old** version when bumping. The `migrateState` function runs migrations sequentially.

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

1. Add the kind string to `StudioWidgetKind` in `src/models/baseTypes.ts`
2. Create a directory under `src/components/widgets/Studio<Kind>Widget/`
3. Add the widget component and an optional setup panel
4. Register the kind in the widget factory / compose drawer

> Custom charts stay app-level: compose the public `@mui/x-charts*` APIs inside an x-studio widget — never patch a new chart type into the shipping `x-charts*` packages. See the "x-studio custom charts" section of `AGENTS.md` for the rationale (BL-182).

## Schema migrations

When changing `StudioState` in a way that breaks deserialization of persisted dashboards:

1. Increment `CURRENT_SCHEMA_VERSION` in `src/store/statePersistence.ts`
2. Add a migration function keyed by the **previous** version number
3. Add a test in `statePersistence.test.ts` with a v(N) fixture

## Docs reference

Local LLM-optimized docs for each public package live at `docs/public/x/<package>/llms.txt`. Always consult these before relying on training data — the in-repo implementation may differ from pre-training snapshots.
