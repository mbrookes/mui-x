# 0001 — Engine / binding package split

**Status:** Accepted, 2026-08-07. Implemented.

## Context

The product requirements (`AG_STUDIO_CLONE_REQUIREMENTS.md`) commit to two things in writing:

- §8.4 — an Angular integration package, a Vue 3 integration package, and a framework-agnostic
  JavaScript embedding API.
- §2.1 — framework-ready embedding listed as in scope.

`@mui/x-studio` was a single package whose `package.json` peer-depended on `react`,
`@mui/material`, `@emotion/react` and `@emotion/styled`. An Angular host consuming it would not
get a wrapper; it would get React in its bundle. The requirement and the package shape were in
direct tension, and nothing recorded that anyone had noticed.

**The seam already existed.** The measurement that matters is the runtime import closure — which
modules can be loaded without React, with `import type` erased, since a type-only edge costs
nothing in a bundle. (`packages/x-studio/scripts/checkReactFreeClosure.py` computes it; it is
checked in so the number can be re-run rather than re-derived. An earlier pass counting files that
merely did not _directly_ import React reported 40%; that number was wrong, because most of those
files transitively reached React anyway.)

```text
                        before   after unblocking
runtime-clean            18,740      23,820 code lines
engine dirs, clean       16,502      18,732   (83 of 98 files)
engine dirs, blocked      3,957       1,729   (15 files, all genuinely React)
```

`StudioController.ts` and `StudioPipeline.ts` imported React **zero** times. `StudioPipeline` was
already documented as "the non-React pipeline façade". Two edges — a locale re-exporter and one
mixed-concern file — were doing all the blocking, and both were things a code-structure review
would ask for on their own merits.

## Options

1. **Leave it as one package.** Costs nothing today, which is exactly why it survived three review
   rounds. At the first Angular or Vue integration it becomes a choice between shipping React
   inside a non-React host, or extracting a core package _after_ `@mui/x-studio`'s 83 public
   exports have set — at which point the extraction is a breaking change to a published API rather
   than a file move.
2. **Ship framework wrappers around the React package.** Angular and Vue hosts get a wrapper, and
   React inside it. Cheapest to build, worst for the consumer, and it makes the bundle-size
   complaint permanent.
3. **Extract `@mui/x-studio-core` and make `@mui/x-studio` a binding over it.** Angular and Vue
   packages become siblings of the React one rather than wrappers around it. This is the standard
   shape for this problem and the one MUI already uses elsewhere (`@mui/x-chat-headless`,
   `base-ui`).

## Decision

Option 3. `@mui/x-studio-core` holds the controller, the four-layer row pipeline, filter scoping
and evaluation, aggregation, chart shapes, the widget factory and layout math, and both query
adapters. `@mui/x-studio` is the React binding over it. `@mui/x-studio-schema` stays below both.

**The boundary is enforced, not asserted.** No module in core imports `react`, `@mui/material` or
`@emotion/*`, and core's vitest config runs `environment: 'node'` deliberately — a test there that
starts needing a DOM is the signal that the module under test grew a browser dependency and
belongs in a binding. That guardrail earned its keep during the extraction itself, catching
`downloadCsv`/`exportGridToCsv` reaching for `document`.

**Three sub-decisions that were not obvious going in:**

- **The widget-kind descriptor went to `x-studio-schema`, not to core.** The AI middleware already
  carried a hand-maintained copy of the same shape, whose own doc admitted the client's values
  "structurally satisfy this subset at the app boundary" — structural typing across a package
  boundary held in agreement by a comment. Both packages already depend on the schema, so that is
  the one place both can read. `StudioCustomWidgetDef` extends `StudioWidgetKindDescriptor`,
  adding only `component`/`setupPanel`/`icon` — the fields that need a React type to express.
- **Six curated subdirectory barrels, not per-file deep paths.** The repo's eslint bans
  `@mui/*/*/*`, so one subpath segment is the most an import may carry. 428 import sites collapsed
  onto `@mui/x-studio-core` plus `/store`, `/engine`, `/adapter`, `/models`, `/utils`, `/locales`.
- **`internals/` became `engine/` and `server/` became `adapter/`.** "Internals" meant "not the
  public component API" inside a React package; in a package that _is_ the engine it says nothing.
  Nothing in `server/` ran on a server.

## Consequences

**What it makes cheap.** An Angular or Vue binding is now a sibling package over a stable engine,
not a wrapper around React. A host that wants the pipeline without any UI imports
`@mui/x-studio-core` directly. The `environment: 'node'` config means the boundary cannot erode
silently — the next accidental DOM dependency fails a test rather than a bundle audit.

**What it costs.** Two packages to version and release instead of one, and a class of change that
now spans a package boundary. `store/StudioController.crossLayer.test.ts` exists because of this:
where the binding genuinely must re-derive an engine rule, the agreement is pinned by a test
rather than by a comment.

**What it forecloses.** Nothing yet. The tier boundary (ADR 0002) is still undrawn, and it should
be chosen with this one in view — a capability that is both Premium-only and engine-side needs the
two boundaries to agree.

**Reversal cost.** Low today (the packages are unpublished; `x-studio` re-exports the engine's
surface, so a merge back would be a file move). It rises to "breaking change for every consumer"
the moment either package publishes — which is the whole reason this was done now.

## Measured result

```text
packages/x-studio-core/src/       31,473 lines, 87 files
  engine/    17,717   the four-layer pipeline, caches, aggregation, chart shapes, StudioPipeline
  locales/    4,923   i18n data
  store/      3,617   StudioController, MutationHistory, runtimeTransforms
  adapter/    3,215   createSimpleAdapter, createBatchingAdapter, aggregationPushdown
  utils/      1,827
  models/       135   re-exports of @mui/x-studio-schema
```

128 modules moved. Zero React / `@mui/material` / `@emotion` imports in core's source. tsc clean
across all five studio packages, eslint clean, 8,682 tests passing.

Closes finding A1 of [`SYSTEM_ARCHITECTURE_REVIEW.md`](../SYSTEM_ARCHITECTURE_REVIEW.md).
