# Architecture review — `@mui/x-studio-schema`

Fresh adversarial review of every file in `packages/x-studio-schema/src/`, verified against
the current code (not docs or prior summaries). Baseline at review time: `tsc -p tsconfig.json`
clean, `vitest --project "x-studio-schema" --run` green (7 files, 291 tests). Every Tier 1/2
runtime claim below was reproduced with a script against the live sources, not inferred.

---

## Tier 1: Correctness & Security

### 1.1 Reducer throws on a parser-accepted payload: `ySeries` containing `null` crashes `normalizeChartSeries`

- `packages/x-studio-schema/src/factories.ts:188` — `normalizeChartSeries` dereferences
  `series.type` with no null/object guard.
- `packages/x-studio-schema/src/applyMutation.ts:84` — `normalizeConfigChartSeries` maps
  `normalizeChartSeries` over every `ySeries` entry of an incoming config; reachable from the
  `addWidget` handler (`applyMutation.ts:364`), the `updateWidget` `config`-patch branch
  (`applyMutation.ts:407`), and `applyBulkUpdate.addedWidgets` (`applyMutation.ts:874`).
- `packages/x-studio-schema/src/statePersistence.ts:385` — `deserializeState` has the same
  exposure for a persisted doc (`ySeries.map(normalizeChartSeries)`).

`parseStateMutation` deliberately leaves widget-config interiors unvalidated on the premise that
they are "a leaf payload the reducer never keys/iterates on"
(`parseStateMutation.ts:132-134`). That premise is no longer true: the reducer now iterates
`config.ySeries`. Failure scenario (reproduced):

```ts
const payload = JSON.parse(
  JSON.stringify({
    type: 'addWidget',
    args: {
      widget: {
        id: 'w1',
        kind: 'chart',
        title: 'T',
        config: { chartType: 'mixed', ySeries: [null] },
      },
      pageId: 'page-1',
    },
  }),
);
parseStateMutation(payload); // → { ok: true }  (accepted at the trust boundary)
applyDocMutation(doc, parsed.mutation); // → TypeError: Cannot read properties of null (reading 'type')
```

The same throw reproduces via `updateWidget` with `config: { ySeries: [null] }`. So a malformed
(or malicious) SSE `state-mutation` payload that passes the wire gate crashes
`applyMutation` inside the client's SSE handler instead of being rejected or no-opped — the
exact failure mode the parser exists to prevent. `normalizeGridColumn` does NOT have this
problem (`typeof col === 'string'` is safe on `null`); only the chart-series path throws.

**Fix (either or both):** make `normalizeChartSeries` total over junk input
(`if (series === null || typeof series !== 'object') return series;` before the `.type` read),
and/or have `parseStateMutation`'s `validateWidget` check that a present `config.ySeries` is an
array of plain objects (it is a documented iteration target now, not a leaf).

### 1.2 `applyBulkUpdate` re-delivery is not idempotent: `addedWidgets` overwrite unconditionally, reverting concurrent user edits

- `packages/x-studio-schema/src/applyMutation.ts:875-878` — `nextWidgets[widget.id] = widget`
  (or its normalized copy) with no existence check.

The reducer's own documentation treats SSE re-delivery as a real event class:
`addWidget` carries an explicit idempotency guard for exactly this reason
(`applyMutation.ts:351-358` — "a re-delivery (e.g. an SSE at-least-once retry, or an AI retry
loop re-issuing the same `add_widget`) must be a no-op — … overwriting would revert their
edit"), as do `addPage` and `addFilter`. `applyBulkUpdate` travels the same at-least-once SSE
channel but takes the opposite behavior. Failure scenario (reproduced):

1. `applyBulkUpdate` adds widget `wb` with title `"AI title"`.
2. User renames `wb` to `"User title"`.
3. The same envelope is re-delivered → `applyDocMutation` runs the bulk again →
   `widgets.wb.title === "AI title"` — the user's edit is silently reverted.

This also undercuts the variant's headline design claim ("a widget the user concurrently
created or edited … survives", `mutationTypes.ts:136-150`): the delta shape protects widgets the
bulk didn't name, but re-delivery clobbers the ones it added. Note the mutation envelope already
carries a dedupe-ready `id` (`mutationTypes.ts:209-215`), but nothing consumes it, so the
reducer is the only line of defense today.

**Fix:** mirror `addWidget` — skip an `addedWidgets` entry whose id already exists in
`nextWidgets` (`if (Object.hasOwn(nextWidgets, widget.id)) continue;`). Layout replacement is
already idempotent, so this closes the only non-idempotent limb.

---

## Tier 2: Design smells

### 2.1 The reference-equality no-op contract is implemented for only half the handlers

`applyDocMutation`'s contract (`applyMutation.ts:953-955`): "when a mutation changes nothing …
the SAME `doc` reference is returned, not a fresh object". `addPage`, `addWidget`,
`updateWidget`, `removeWidget` (unknown id), `addFilter`, and `removeFilter` honor it —
`updateWidget` at considerable implementation cost. But:

- `setActivePage` (`applyMutation.ts:770-783`) — activating the already-active page returns a
  fresh doc (reproduced: `sa === doc` is `false`). Contrast `addPage`, which explicitly
  same-refs this exact case at `applyMutation.ts:309-312`.
- `setDashboardTitle` (`applyMutation.ts:326-334`) and `renamePage` (`applyMutation.ts:697-711`)
  — writing the identical title returns a fresh doc.
- `setWidgetColSpan` (`applyMutation.ts:627-695`) — re-writing the identical span, or
  `columns: null` for a widget with no span entry, rebuilds the page.
- `setWidgetLayout` (`applyMutation.ts:595-625`) — identical `rows` rebuilds the page.
- `renameAIThread` (`applyMutation.ts:910-935`) — a `threadId` matching NO thread still returns
  a fresh doc wrapping a content-identical `threads` array (an unknown-id case the contract
  names explicitly).
- `applyBulkUpdate` (`applyMutation.ts:814-908`) — unconditionally returns a fresh doc.

Consequence: each of these pushes a spurious undo entry through the client's
reference-equality `commitDocPatch` guard (the precise regression the `updateWidget`
`changedConfig` machinery, `applyMutation.ts:409-415`, was built to prevent) — e.g. a
re-delivered or already-satisfied `set_active_page` makes Ctrl+Z a visible no-op once.
**Direction:** either add the cheap value-equality early-returns to the scalar handlers
(`title === args.title`, `activePageId === pageId`, thread-not-found), or narrow the documented
contract to the handlers that actually honor it.

### 2.2 Layout handlers skip the unknown-id guard every other widget-targeting handler has

`updateWidget` (`applyMutation.ts:390`) and `removeWidget` (`applyMutation.ts:528`) no-op on a
`widgetId` absent from `state.widgets`. `setWidgetColSpan` (`applyMutation.ts:627-695`) checks
only the page: a span write for a widget id that exists nowhere persists an orphan
`widgetColSpans` entry (reproduced: `{"ghost-widget": 10}` lands in the doc and serializes),
dead weight until some later layout op happens to prune it. Similarly `setWidgetLayout`
(`applyMutation.ts:595-625`) installs `args.rows` verbatim — rows may name widget ids that don't
exist in `state.widgets`, leaving pages referencing phantom widgets. Both are trusted-producer
assumptions living in the same file that pointedly refuses to trust `rowWidgetIds` from the same
producer (`applyMutation.ts:639-651`). **Direction:** in `setWidgetColSpan`, no-op unless
`Object.hasOwn(state.widgets, widgetId)`; in `setWidgetLayout`, drop (or reject) row entries not
present in `state.widgets`.

### 2.3 Series-alias normalization on live writes is documented as total but covers only two of four write paths

`normalizeConfigChartSeries`'s contract (`applyMutation.ts:70-77`): "the alias never survives a
LIVE write (`updateWidget`/`addWidget`)". Actual coverage: the `updateWidget` `config` patch
(`applyMutation.ts:407`) and `addWidget`/`applyBulkUpdate.addedWidgets` are normalized, but

- `updateWidget.changes.config` — the wholesale config replacement inside the `changes` merge
  (`applyMutation.ts:445-461`) copies `definedChanges` verbatim, so a `changes.config.ySeries`
  carrying `seriesType` survives, and
- `applyBulkUpdate.updatedWidgets[].config` — the shallow merge at `applyMutation.ts:888-897` is
  not normalized either.

No live misbehavior today only because chart readers still defensively re-normalize at read time
(e.g. `packages/x-studio/src/components/widgets/StudioChartWidget/StudioMixedChart.tsx:67`),
which itself shows the "every consumer can read a single field" goal (`factories.ts:182-186`)
isn't trusted yet. **Direction:** run `normalizeConfigChartSeries` on the two uncovered paths
(both already have the config object in hand), or correct the comment to name the actual
coverage.

---

## Tier 3: Minor / cosmetic

### 3.1 `StudioChartSeries` documents the alias direction backwards

`packages/x-studio-schema/src/widgetTypes.ts:76-84` documents `seriesType` as the real field and
`type` as "Alias for `seriesType` — preferred spelling in config objects." Everything else —
`normalizeChartSeries` (`factories.ts:178-186`, "`type` is the canonical spelling … the
deprecated `seriesType` alias"), `applyMutation.ts:70-71`, and `ARCHITECTURE.md` — declares
`type` canonical and `seriesType` deprecated. The interface JSDoc (the first thing a consumer
reads) should match: mark `seriesType` `@deprecated` and `type` canonical.

### 3.2 `toUtcYMD`'s fast path accepts dates its own comment claims fall through

`packages/x-studio-schema/src/temporalUtils.ts:40-46`: the range check (`day <= 31`) admits
per-month-invalid dates, so (reproduced) `truncateToPeriod('2024-06-31', 'day')` returns
`'2024-06-31'` while the same instant as a `Date` returns `'2024-07-01'` — equal semantic inputs
bucket into different groups depending on representation. A garbage no-offset tail is also
accepted (`'2024-06-01Tgarbage'` → `'2024-06-01'`, where the `new Date` fallback would yield
`null`). The comment claims malformed dates "fall through to `new Date(...)`" — only true for
out-of-range components like `2024-13-40`. Tighten the comment, or validate the day against the
month (and the tail shape) before taking the fast path.

### 3.3 The prototype-hazard key denylist is spelled three times in one package

`applyMutation.ts:64` (`UNSAFE_KEYS` + `isSafePatchKey`), `parseStateMutation.ts:103`
(a second identical `UNSAFE_KEYS`), and `parseStateMutation.ts:67-74` (`isSafeId` re-lists the
same three literals inline). The comments cross-reference each other ("mirrors
`applyMutation.ts`'s `UNSAFE_KEYS`") — within a single package that's a shared-constant import,
not a mirror. One tiny internal module (`unsafeKeys.ts`) would remove the drift surface.

### 3.4 `createDefaultWidget` silently ignores `overrides.customConfig` for built-in kinds

`packages/x-studio-schema/src/factories.ts:150-167`: the custom-kind branch honors
`overrides?.customConfig`; the built-in branch drops it without signal. A caller passing
`createDefaultWidget('grid', { customConfig: {...} })` type-checks (the override bag is not
generic over `K`) and gets nothing. Either thread it into the built-in config (the
`customConfig` key exists on `StudioSharedWidgetConfig` for every kind) or exclude it from the
overrides type for built-in kinds.

### 3.5 Dead/inconsistent shell-override lines in `createDefaultStudioState`

`packages/x-studio-schema/src/factories.ts:280-281`: `selectedFieldId`/`selectedSourceId` get a
`?? null` re-default after the `...sessionOverrides?.shell` spread, but `selectedWidgetId` does
not. Since `CreateDefaultStudioStateOverrides.session` is `Partial<StudioSession>` (a provided
`shell` is a complete `StudioShellState`), the two `?? null` lines can never change the result —
they are dead code that reads as if partial shells were supported for two of the three selection
fields. Delete them (or make `shell` genuinely `Partial<StudioShellState>` and default all
three).

### 3.6 "Zero runtime dependencies" vs. `package.json` `dependencies`

`packages/x-studio-schema/src/index.ts:9` ("Zero runtime dependencies") and the `package.json`
description ("dependency-free") sit next to `package.json:19-21` declaring
`"@mui/x-chat-headless": "workspace:*"` under `dependencies`. The import
(`chatTypes.ts:8`) is type-only and erased at runtime — `ARCHITECTURE.md` states this nuance
correctly — but declaring it as a full runtime dependency contradicts both claims in machine-
readable metadata (and would force an install of `x-chat-headless` on any future consumer).
Move it to `devDependencies` (type-only imports need only compile-time resolution) or soften the
two "zero/dependency-free" claims the way `ARCHITECTURE.md` already does.

### 3.7 Orphaned JSDoc block in `mutationTypes.ts`

`packages/x-studio-schema/src/mutationTypes.ts:137-151`: the `applyBulkUpdate` delta-shape
design comment is immediately followed by a second JSDoc (`/** Widget IDs to delete… */`) on
`removedWidgetIds`, so the first block attaches to nothing and is invisible to editor hovers.
Move it above the `type: 'applyBulkUpdate'` variant member where it describes the whole shape.

---

**Summary:** Tier 1: 2 findings · Tier 2: 3 findings · Tier 3: 7 findings.
