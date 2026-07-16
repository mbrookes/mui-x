# `@mui/x-studio-schema` — architecture & correctness review

Tiers: 0/1/2

Fresh clean-slate review of `packages/x-studio-schema/src/**` (all type modules, the
`applyMutation` reducer, `parseStateMutation` wire validator, `statePersistence`
serialize/deserialize + migrations, `factories`, `configKeyValidation`,
`widgetTypeGuards`, `unsafeKeys`, `temporalUtils`, `anomalyDetection`). The package has
been through many hardening rounds; the reducer, wire validator, and prototype-hazard
handling are in excellent shape and I found no Tier 1 (security / silent-corruption /
immutability) defect. The findings below are one robustness asymmetry between the two
load-boundary validators and two smaller consistency/doc issues.

---

## Tier 2 — robustness / consistency

### T2-1 — `findMissingRequiredField` rejects the WHOLE doc for an incomplete-but-loadable filter scope, defeating `deserializeState`'s graceful per-filter drop (whole-dashboard data loss)

**Where:** `statePersistence.ts:307` (`findMissingRequiredField`, called by `migrateState`
on both the already-current fast path, line 401, and the post-migration result, line 498)
vs. `statePersistence.ts:758-802` (`deserializeState`'s filter screen).

**What's wrong.** `findMissingRequiredField` was upgraded (finding "T3-1") from a
crash-prevention check to the FULL `isValidFilterScope(filter.scope)` — which requires not
only a record scope with a known `kind`, but every id field that kind mandates
(`widget`→`widgetId`, `cross-filter`/`interactive`→`sourceWidgetId`+`pageId`,
`dashboard-date-range`→`sourceId`+`pageId`). Any single filter whose scope is
well-formed-but-incomplete (e.g. `scope: { kind: 'widget' }` with no `widgetId`, or a
`dashboard-date-range` missing `sourceId`) makes `findMissingRequiredField` return a
non-null field name, so `migrateState` returns `{ success: false, state: null }`.

`migrateState` is the mandatory first gate in the real load path:
`StudioController.loadSerializedState` (StudioController.ts:2372-2384) runs
`migrateState(serialized)` and only calls `deserializeState` when it succeeds — on failure
it commits nothing and the entire dashboard fails to load. But `deserializeState` itself is
explicitly built to DROP exactly these filters gracefully: its filter screen (line 771)
uses the identical `isValidFilterScope` predicate to remove the offending entry and load the
rest of the doc. So the two load-boundary validators disagree on the same corruption, and
the more destructive one (whole-doc rejection) runs first and wins — `deserializeState`'s
salvage logic for invalid-scope filters is dead code in the normal pipeline.

**Why it matters (concrete scenario).** A shared/hand-edited/legacy persisted doc (exactly
the untrusted-boundary threat model this whole function targets) containing ONE filter with
an incomplete scope causes the user's ENTIRE dashboard — every page, widget, expression
field, and every other valid filter — to fail to load, when dropping that one filter would
have loaded everything else. An incomplete `{ kind: 'widget' }` scope does not actually
crash anything downstream (`serializeDoc` reads `f.scope.kind` fine, and the reducer's
`dropWidgetScopedFilters` does `isRemoved(f.scope.widgetId)` → `isRemoved(undefined)` →
`false`), so the strict rejection is pure over-strictness, not crash-prevention.

**Fix.** Restore `findMissingRequiredField`'s stated purpose ("reject a doc that would
_crash_ `deserializeState`/`serializeDoc`/the reducer"): reject a filter only for the
scope shapes that genuinely crash a no-optional-chaining `f.scope.kind` read — a non-record
filter, or a non-record/absent `scope`, or a non-string `scope.kind`. Leave a
present-but-incomplete scope (valid `kind`, missing a required id) for `deserializeState`'s
per-entry drop, which already handles it. Concretely, replace the
`!isValidFilterScope(filter.scope)` gate at line 307 with a check that the filter's `scope`
is a record whose `kind` is a string (the weaker crash-prevention check the code comment and
`ARCHITECTURE.md` still describe — see T3-2). This makes migrate and deserialize agree that
an incomplete-scope filter is droppable, not fatal.

---

## Tier 3 — minor / documentation

### T3-1 — Load boundary does not screen widget `titleMode`/`subtitleMode` (and other widget scalars) that the wire boundary explicitly rejects

**Where:** `parseStateMutation.ts:188-193` and `:441-446` (wire boundary rejects
`titleMode`/`subtitleMode` not in `'auto'|'manual'`, and `kind`/`title`/`subtitle`/`sourceId`
type-checks) vs. `statePersistence.ts:586-689` (`deserializeState`'s widget map, which
screens only key-safety, config-record-ness, and `chartType` membership).

**What's wrong.** The package went to deliberate lengths to make `field`/`operator`/
`chartType` screening symmetric between the wire and load boundaries (findings 2 / T2-3 /
T3-1 in the history), and the wire validator explicitly rejects `titleMode: 42` because "a
junk value … persists into a field the client's auto-title logic branches on." But the load
boundary never screens `titleMode`/`subtitleMode` (nor `kind`/`title`/`subtitle`/`sourceId`
types) on a persisted widget. A hand-edited/foreign persisted widget carrying
`titleMode: 42` (or `kind: 42`) loads verbatim and reaches the exact client auto-title logic
the wire check was added to protect — the byte-identical value delivered over SSE is
rejected. This is an asymmetry by the package's own stated standard for these specific
fields.

**Why it's Tier 3 / likely tolerable.** The failure mode is benign (auto-title picks the
wrong mode / a non-string label renders oddly), not data corruption, and `deserializeState`
is documented as deliberately shallow on widget-config leaves. Note this is distinct from
the config-KEY-validity asymmetry, which is _intentionally_ not enforced on load
(retention-across-`chartType`-switch). If closing it, add an `'auto'|'manual'`-or-drop
normalization for `titleMode`/`subtitleMode` in the widget map, mirroring the `chartType`
key-drop already there.

**Fix (optional).** Either screen these scalars on load (drop/normalize a non-conforming
`titleMode`/`subtitleMode`, coerce non-string `title`/`subtitle`), or accept the asymmetry
and note in `parseStateMutation`'s doc that these leaf checks are wire-only.

### T3-2 — `ARCHITECTURE.md` understates `findMissingRequiredField`'s filter-scope check

**Where:** `ARCHITECTURE.md:256` states `findMissingRequiredField` verifies "every
`filters[*]` entry is a record with a record `scope` whose `kind` is a string."

**What's wrong.** The code no longer does the weaker "record scope whose kind is a string"
check — it calls the full `isValidFilterScope` (kind membership among the five kinds AND
every required id field present) at `statePersistence.ts:307`. The doc still describes the
older, weaker crash-prevention intent. This is both a doc/code drift and, notably, evidence
that the _documented_ intent (weaker, crash-prevention-only) is the correct one — the code
drifted stronger, which is precisely the over-rejection of T2-1. Fixing T2-1 by reverting
line 307 to the weaker check also re-aligns the code with this doc sentence; if instead the
strict check is kept, update this sentence to say it requires a fully-valid
`StudioFilterScope`.
