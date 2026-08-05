/**
 * The per-ENTRY screens a `StudioDoc` must pass before it becomes live state.
 *
 * These screens used to live inside `deserializeState` (`statePersistence.ts`), which made
 * the PERSISTENCE load boundary the only producer of a doc that applied them. It is not the
 * only producer: `createDefaultStudioState` (`factories.ts`) builds a doc from
 * `overrides.doc`, and that bag is reachable straight from the public `Studio initialState`
 * prop via `new StudioController(initialState)`. Three defects traced through that hole,
 * each of which the load boundary already repairs per-entry:
 *
 *  - a filter with no `scope` → `TypeError: Cannot read properties of undefined (reading
 *    'kind')` inside `serializeDoc`, on the FIRST autosave and on every undo snapshot;
 *  - `config: null` on a widget → a throw mid-reduce in `shallowRecordEqual`
 *    (`Cannot convert undefined or null to object`) on the next config-touching mutation;
 *  - `ai.threads: 'junk'` → `threads.map is not a function` on the first `renameAIThread`.
 *
 * `removeSpanEntries`' own comment in `applyMutation.ts` already names `initialState` as the
 * one producer of an unscreened map. Extracting the screens here — rather than duplicating
 * them in the factory — is what keeps the two producers from drifting, the same reason
 * `internalGuards.ts` exists.
 *
 * IMPORT-CYCLE CONSTRAINT (load-bearing): this module must NOT import `factories.ts`,
 * `applyMutation.ts` or `statePersistence.ts`, because `factories.ts` imports IT. That is
 * why the load boundary keeps three things of its own rather than moving them here:
 *  - the legacy leaf-shape normalization (`normalizeGridColumn`/`normalizeChartSeries`),
 *    which lives in `factories.ts` and is a persisted-shape concern, not a screen;
 *  - `normalizePersistedPages` and the rank-filter uniqueness sweep, which live in
 *    `applyMutation.ts` and need its layout/rank machinery;
 *  - the `dashboard.activePageId` / `ai.activeThreadId`-against-pages reconciliations, which
 *    need the FINAL page map.
 *
 * Reference stability is preserved throughout: every screen returns the SAME array/record/
 * entry object when nothing needed dropping or repairing, so a well-formed doc costs nothing.
 */
import type { StudioAIState } from './aiTypes';
import type { StudioExpressionField } from './expressionTypes';
import type { StudioDoc, StudioFilterScope, StudioFilterState } from './stateTypes';
import type { StudioWidget, StudioWidgetConfig } from './widgetTypes';
import { isSafeKey } from './unsafeKeys';
import { hasUnsafeOwnKeys, isValidFilterScope } from './parseStateMutation';
import {
  isPlainRecord as isRecord,
  stripUnsafeOwnKeys,
  repairFilterDependsOn,
} from './internalGuards';
import {
  isStudioChartType,
  isStudioExpressionOperator,
  isStudioFilterOperator,
  isStudioRelationshipType,
  isTitleModeValue,
  OPTIONAL_WIDGET_STRING_FIELDS,
  WIDGET_TITLE_MODE_FIELDS,
} from './widgetTypeGuards';

/**
 * Screen each ENTRY of an untrusted array with `isRecord`, dropping non-record junk — the
 * same per-entry screen the `filters`/`ai.threads` paths apply, extended to `relationships`
 * and `expressionFields`, whose entries the client iterates on hot paths (`ef.sourceId`,
 * `r.sourceId`) with no optional chaining. A non-array coerces to `[]` (symmetric with the
 * prior container-only coercion). Reference-STABLE: returns the SAME array when every entry
 * survives, so a well-formed doc keeps its identity for cross-load memoization.
 *
 * `isValidEntry` is the REQUIRED-LEAF screen (finding: this helper validated record-ness
 * and nothing else, while its own doc comment justified its existence by pointing at the
 * unguarded derefs the leaves feed). Record-ness alone let e.g. `expressionFields: [{ id:
 * 'e1', label: 'Margin', sourceId: 's1', isMeasure: false }]` — no `expression` at all —
 * load with `success: true`, and the first widget referencing `e1` then hit
 * `x-studio`'s `expressionEvaluator.ts` `return 'joinSourceId' in expr;` and threw
 * `TypeError: Cannot use 'in' operator to search for 'joinSourceId' in undefined`, taking
 * down the whole pipeline — with NO self-heal, since `serializeDoc` re-persisted the junk
 * forever. It receives an already-record, already-own-key-screened entry, so it only has
 * to check the leaves consumers dereference unguarded.
 * @param {Record<string, unknown>} entry An already-record, already-own-key-screened entry.
 * @returns {boolean} `true` when every leaf the consumers dereference unguarded is present.
 */
const screenRecordArray = <T>(
  value: unknown,
  isValidEntry?: (entry: Record<string, unknown>) => boolean,
): T[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  // Reject non-record entries AND entries carrying a prototype-hazard OWN key. The
  // client spreads a relationship/expression-field on hot paths (`{ ...ef }`, `Object.assign`),
  // so an own `"__proto__"`/`"constructor"`/`"prototype"` DATA key (as `JSON.parse` materializes
  // it on a shared/hand-edited doc) is a pollution hazard the wire boundary would reject — drop
  // the whole entry, matching the widgets/filters own-key screen. Reuses the SAME predicate.
  const safe = value.filter(
    (entry) =>
      isRecord(entry) &&
      !hasUnsafeOwnKeys(entry) &&
      (isValidEntry === undefined || isValidEntry(entry)),
  );
  return (safe.length === value.length ? value : safe) as T[];
};

/**
 * Depth bound for the recursive `expression` tree of an `expressionFields` entry.
 *
 * `StudioExpression` is the only genuinely RECURSIVE shape that crosses this boundary,
 * and not every consumer walker is self-bounded: `x-studio`'s `expressionEvaluator` carries
 * its own depth counter, but `internals/expressionRefs.ts`'s `collectExpressionRefs` /
 * `collectJoinSourceIds` recurse through `inputs` with no bound at all, so a tree
 * nested deeply enough overflows the stack the first time a widget referencing the field
 * renders. Bound it here, at the boundary, so no walker downstream has to.
 *
 * `32` is this package's uniform nesting bound for untrusted JSON (`parseStateMutation.ts`'s
 * `MAX_DEPTH`, applied to `widget.config` and `filter.value` at the wire boundary), and is
 * deliberately generous: the expression builder UI's deepest built-in template is ~4 levels,
 * so no authorable tree comes near it.
 */
const MAX_EXPRESSION_DEPTH = 32;

/**
 * True when `node` is a structurally valid `StudioExpression` — one of the union's four
 * members, with the leaves that member's consumers dereference, nested no deeper than
 * {@link MAX_EXPRESSION_DEPTH}.
 *
 * The function branch is tested FIRST because `operator` is the only key that introduces
 * RECURSION: any node carrying it must be a well-formed function node (a known operator, an
 * ARRAY `inputs`, and every input itself valid) or be dropped, regardless of which member a
 * given consumer's guard precedence would resolve it to. The remaining three branches follow
 * the order `evaluateExpression` discriminates them in, so a node this screen accepts is the
 * same member the evaluator resolves it to.
 *
 * The `operator` membership check is the point of the recursion: an unknown operator is not a
 * crash but a SILENT wrong answer — every evaluator walker falls through to its `default:`
 * case and the whole computed column evaluates to `null` — which is the same fail-open class
 * as an unknown relationship `type`, and is why that sibling discriminant is membership-checked
 * too rather than merely type-checked.
 *
 * An interior node is deliberately NOT own-key screened for `__proto__`/`constructor`/
 * `prototype`: unlike a relationship/expression-field/filter/thread — each of which the client
 * SPREADS or `Object.assign`s (the pollution vector the sibling screens close) — an expression
 * node is only ever WALKED (`node.operator`, `node.inputs`, `node.id`) and re-serialized by
 * value. There is no spread of an interior node anywhere in `x-studio`, so an own unsafe key on
 * one is inert data that the four member branches above already refuse to resolve. Screening it
 * would DROP the whole (repairable, user-authored) expression field over a key nothing reads.
 * @param {unknown} node A node of the expression tree.
 * @param {number} depth Nesting level of `node`, `0` for the root.
 * @returns {boolean} `true` when the node resolves to exactly one union member with valid leaves.
 */
const isValidExpressionNode = (node: unknown, depth: number): boolean => {
  if (depth > MAX_EXPRESSION_DEPTH) {
    return false;
  }
  if (!isRecord(node)) {
    return false;
  }
  // StudioFunctionExpression — the recursive member.
  if ('operator' in node) {
    return (
      isStudioExpressionOperator(node.operator) &&
      Array.isArray(node.inputs) &&
      node.inputs.every((input) => isValidExpressionNode(input, depth + 1))
    );
  }
  // StudioValueExpression. `value` is a deliberately uninterpreted scalar leaf (the evaluator
  // returns it verbatim), but `type` is a closed three-member union, so it gets the same
  // membership treatment as the operator above.
  if ('type' in node && 'value' in node) {
    return node.type === 'number' || node.type === 'string' || node.type === 'boolean';
  }
  // StudioJoinFieldExpression — both ids are destructured and used as record keys unguarded.
  if ('joinSourceId' in node && 'fieldId' in node) {
    return typeof node.joinSourceId === 'string' && typeof node.fieldId === 'string';
  }
  // StudioFieldExpression — the terminal reference member. `aggregation` is optional and
  // defaulted downstream, so it follows this file's fallback-over-drop convention.
  if ('id' in node) {
    return typeof node.id === 'string';
  }
  // Matches none of the four members: an unresolvable node every walker would skip.
  return false;
};

/**
 * Required-leaf screen for an `expressionFields` entry. `id`/`sourceId` are
 * identity data every consumer compares as strings, `label` is required by
 * `StudioExpressionField` and rendered directly as a React child by every field picker
 * (a non-string throws on first render), and `expression` is the tree `x-studio`'s
 * `expressionEvaluator` walks with an unguarded `'joinSourceId' in expr` — a
 * missing/non-record `expression` is the crash described on {@link screenRecordArray}.
 *
 * `expression` is validated all the way DOWN via {@link isValidExpressionNode}, not merely
 * for record-ness: it is a recursive tree whose interiors carry both a closed operator union
 * (fail-open to a silently-`null` column when unknown) and unbounded nesting (stack overflow
 * in the unbounded consumer walkers).
 *
 * `isMeasure` is required by the interface but documents `false` as its default, so an ABSENT
 * value is legal here; a PRESENT non-boolean is not. It decides whether the field is a per-row
 * calculated column or a single aggregate over the whole dataset, so a truthy junk value
 * (`isMeasure: 'no'`) silently loads a calculated column as a measure and reports a wrong
 * number everywhere it appears.
 *
 * The remaining fields are optional, defaulted, or display-only, so they follow this
 * file's fallback-over-drop convention and are not screened here.
 */
const isExpressionFieldSafe = (entry: Record<string, unknown>): boolean =>
  typeof entry.id === 'string' &&
  typeof entry.sourceId === 'string' &&
  typeof entry.label === 'string' &&
  (entry.isMeasure === undefined || typeof entry.isMeasure === 'boolean') &&
  isValidExpressionNode(entry.expression, 0);

/**
 * Required-leaf screen for a `relationships` entry — the sibling of
 * {@link isExpressionFieldSafe}. All four endpoint ids/fields are read as strings by the
 * join-path resolver with no optional chaining, and `type` is the discriminant every join
 * builder switches on: an unknown value fails open into the `many-to-one` branch and
 * silently produces wrong joined rows, the same fail-open class the filter `operator`
 * membership check closes one level up.
 *
 * The `type` membership test goes through `isStudioRelationshipType`
 * (`widgetTypeGuards.ts`), whose list is COMPILE-LOCKED for completeness against
 * `StudioRelationship['type']`. The bare `new Set([...])` this screen used to carry had no
 * such lock, unlike the three sibling closed-union lists in that file, so a FOURTH
 * relationship type would have compiled cleanly and made this screen silently drop every
 * persisted relationship using it at load.
 *
 * `id` is checked for the same reason both siblings check theirs ({@link isExpressionFieldSafe},
 * and the preset screen whose own comment calls `id` "the one field it shares with that
 * screen"). It is REQUIRED by `StudioRelationship` and it is how the entry is addressed:
 * `StudioController.updateRelationship(id, patch)`/`removeRelationship(id)` both key off
 * `rel.id`, and `RelationshipPanel` renders its delete button as
 * `onClick={() => controller.removeRelationship(rel.id)}`. A relationship with no
 * `id` (or `id: 42`) therefore loaded successfully, rendered in the data drawer, and was
 * permanently unremovable and unupdatable — re-persisted forever with no self-heal — while
 * two such entries also collided on the React list key.
 *
 * The three `junction*` fields are deliberately NOT screened for `type: 'many-to-many'`,
 * even though they are documented as required for that discriminant: `dataSourceGraph.ts`'s
 * join builders guard every read (`if (!rel.junctionSourceId || !rel.junctionSourceField ||
 * !rel.junctionTargetField) { continue; }`, and `rel.type === 'many-to-many' &&
 * rel.junctionSourceId` at the reachability sites), so an incomplete entry is SKIPPED rather
 * than dereferenced. There is no unguarded read to protect, and dropping the whole
 * relationship would lose a repairable entry the data drawer can still show and edit.
 */
const isRelationshipSafe = (entry: Record<string, unknown>): boolean =>
  typeof entry.id === 'string' &&
  typeof entry.sourceId === 'string' &&
  typeof entry.targetId === 'string' &&
  typeof entry.sourceField === 'string' &&
  typeof entry.targetField === 'string' &&
  isStudioRelationshipType(entry.type);

/**
 * Repair a thread's `messages`/`name` leaf shapes (F1 finding): the container/entry screen
 * around this helper's call site validated "is a record" and "carries no unsafe own key" but
 * never the LEAF shapes — a thread with `messages` as a non-array (e.g. a string) or `name`
 * as a non-string previously passed through verbatim. `useChatThreads.ts`'s
 * `activeThread?.messages ?? []` only guards nullish, not wrong-type, so a string `messages`
 * reached `<ChatBox messages={...}>` and crashed on `.map`; a non-string `name` crashes as an
 * invalid React child the first time the thread selector renders it. Repair-in-place (coerce)
 * rather than drop the whole thread — mirroring `page.title`/`dashboard.title`'s
 * fallback-over-drop treatment — since neither field is identity data (`id` still is, and is
 * left untouched). Non-record input is returned as-is; the caller's own record screen handles
 * it. Reference-stable when both fields already have the correct shape.
 */
const repairThreadLeafShapes = <T>(thread: T): T => {
  if (!isRecord(thread)) {
    return thread;
  }
  // Screen the message ENTRIES, not just the container (finding: this helper coerced
  // `messages` to an array but never looked inside it, so `messages: [null]` survived).
  // `<ChatBox messages={…}>` maps each entry and reads `m.role`/`m.content` with no
  // optional chaining, so a `null`/primitive entry throws on first render of the thread —
  // the same per-entry gap the sibling `filters`/`relationships`/`ai.threads` screens
  // already close one level up. Drop just the junk entries (repair-in-place), consistent
  // with this helper's fallback-over-drop treatment of the rest of the thread.
  //
  // A surviving message is deliberately NOT own-key screened for `__proto__`/`constructor`/
  // `prototype`, unlike its thread container: `x-studio` never spreads or `Object.assign`s a
  // single message (`useChatThreads` replaces the whole `messages` ARRAY and `ChatBox` reads
  // `m.role`/`m.content` by name), so there is no pollution vector to close, and dropping a
  // message would silently erase user/assistant conversation content — strictly worse than
  // the inert own key. The thread ITSELF is screened, because `renameAIThread` DOES spread it
  // (`{ ...t, name }`).
  const rawMessages = (thread as { messages?: unknown }).messages;
  const messagesIsArray = Array.isArray(rawMessages);
  const safeMessages = messagesIsArray ? rawMessages.filter((m) => isRecord(m)) : [];
  const messagesOk = messagesIsArray && safeMessages.length === rawMessages.length;
  const nameOk = typeof (thread as { name?: unknown }).name === 'string';
  // `createdAt` is REQUIRED by `StudioAIChatThread`, and both timestamps are consumed as strings
  // by the chat panel's thread sort (`bTime.localeCompare(aTime)` in `useChatThreads`). A hostile
  // or hand-edited doc can carry a thread with a non-string / missing `createdAt` or a
  // non-string `updatedAt`; left unrepaired it loads successfully and then throws a `TypeError`
  // inside the sort `useMemo`, crashing the whole panel on mount (the comparator only runs with
  // 2+ threads). Coerce a bad `createdAt` to a safe epoch default and DROP (rather than pass
  // through) a non-string `updatedAt` — mirroring the fallback-over-drop treatment above, since
  // neither timestamp is identity data.
  const createdAtOk = typeof (thread as { createdAt?: unknown }).createdAt === 'string';
  const hasUpdatedAt = 'updatedAt' in (thread as object);
  const updatedAtOk =
    !hasUpdatedAt || typeof (thread as { updatedAt?: unknown }).updatedAt === 'string';
  if (messagesOk && nameOk && createdAtOk && updatedAtOk) {
    return thread;
  }
  const repaired = {
    ...thread,
    // Keep the surviving messages rather than resetting to `[]`: only the junk entries are
    // dropped (a non-array `messages` still degrades to the empty array via `safeMessages`).
    ...(messagesOk ? {} : { messages: safeMessages }),
    ...(nameOk ? {} : { name: 'Untitled Thread' }),
    ...(createdAtOk ? {} : { createdAt: new Date(0).toISOString() }),
  } as T & { updatedAt?: unknown };
  // Delete a non-string `updatedAt` outright (it's optional) so it can't reach the comparator;
  // the sort falls back to `createdAt`, which is now guaranteed to be a string.
  if (!updatedAtOk) {
    delete repaired.updatedAt;
  }
  return repaired as T;
};

/**
 * Screen one preset-embedded filter with the SAME semantic checks the `doc.filters` screen
 * applies to the fields that travel VERBATIM into live `doc.filters` when a preset is
 * applied. `@mui/x-studio`'s `docTransforms.applyFilterPreset` rematerializes each
 * preset filter as `{ ...f, id: fresh, scope: page }` — it re-stamps `id`/`scope` but
 * carries `field`/`operator`/`operator2` through unchanged and performs NO validation of its
 * own — so a junk `operator: 'equal'` (a plausible typo for `'equals'`) or `field: 42` would
 * land in live `doc.filters` as an active, fail-open chip the moment the user clicks "apply
 * preset": displayed data silently unfiltered while the UI claims a filter is applied. Screen
 * for it here (scope checks are unnecessary — `applyFilterPreset` re-stamps scope).
 */
const isPresetFilterSafe = (entry: unknown): boolean => {
  if (!isRecord(entry)) {
    return false;
  }
  // Reject a preset inner filter carrying a prototype-hazard OWN key. This is the
  // sharpest asymmetry: `applyFilterPreset` rematerializes each preset filter into live
  // `doc.filters` via `{ ...f, id: fresh, scope: page }`, so an own `"__proto__"` key would
  // land on a LIVE filter, and the NEXT load's filter own-key screen then silently drops that
  // whole filter. Screen it here so the two boundaries agree. Reuses the SAME predicate.
  if (hasUnsafeOwnKeys(entry)) {
    return false;
  }
  // `id` must be a string, matching the top-level `doc.filters` screen's identical check
  // (finding: this predicate screened `field`/`operator`/`operator2` but skipped `id`, the
  // one field it shares with that screen). `applyFilterPreset`'s id-remap loop does
  // `idMap.set(f.id, fresh)` and the drawer keys its rows off the preset filter id, so a
  // non-string `id` yields a preset row that can never be matched or removed — exactly the
  // state the sibling screen rejects for the byte-identical payload.
  if (typeof entry.id !== 'string') {
    return false;
  }
  if (typeof entry.field !== 'string') {
    return false;
  }
  if (!isStudioFilterOperator(entry.operator)) {
    return false;
  }
  if (entry.operator2 !== undefined && !isStudioFilterOperator(entry.operator2)) {
    return false;
  }
  return true;
};

/**
 * Coerce a preset's `name` to a string, symmetric with `page.title`'s
 * `'Untitled Page'` / `dashboard.title`'s `'Untitled Dashboard'` fallback pattern
 * (F1 finding): `screenFilterPresets` validated the preset container (a record with
 * an array `filters`) but never `preset.name`, which `StudioFiltersDrawer` renders
 * VERBATIM as a Chip `label` — a non-string `name` (`null`, `42`, an object) crashes
 * that render as an invalid React child, the same class of boundary gap
 * `page.title`/`dashboard.title` were already closed for. Repair-in-place (coerce)
 * rather than drop the whole preset — the name is display metadata, not identity
 * data, matching the fallback-over-drop treatment `page.title` gets. Reference-
 * stable when `name` is already a string.
 */
const safePresetName = (name: unknown): string =>
  typeof name === 'string' ? name : 'Untitled Filter Preset';

/**
 * Screen `filterPresets`: drop any entry that
 * is not a record with an array `filters`, coerce a non-string `preset.name` to a
 * fallback (F1 finding, see {@link safePresetName}), AND screen each preset's own
 * `filters` array with {@link isPresetFilterSafe} — record-ness (a `null` inner filter
 * entry crashes `applyFilterPreset`'s id-remap loop `idMap.set(f.id, …)` the same way a
 * top-level junk entry does) PLUS the `field`/`operator`/`operator2` semantic checks,
 * because those fields travel verbatim into live `doc.filters` via
 * `applyFilterPreset`, one indirection past the `doc.filters` screen. Reference-
 * stable at both levels: returns the SAME outer array (and the SAME inner `filters`
 * array on each surviving preset) when nothing is dropped or repaired.
 *
 * A preset's OWN `id` is required to be a string too — the outer sibling of the `id` check
 * {@link isPresetFilterSafe} makes one level down, and of {@link isRelationshipSafe}'s. It is
 * identity data: `docTransforms`' `applyFilterPreset`/`removeFilterPreset`/rename all locate
 * the preset with `p.id === presetId` (a strict compare that never coerces) and the drawer
 * keys its rows off it, so a preset with no `id` (or `id: 42`) would load, render a chip, and
 * be permanently unappliable, unrenamable and unremovable. Drop rather than coerce, matching
 * every other identity-data screen in this file (`name` is display metadata and still gets
 * the fallback-over-drop treatment).
 *
 * The preset CONTAINER is own-key screened with `hasUnsafeOwnKeys` too, closing the last gap
 * in this file's own-key coverage: its two array siblings (`relationships[i]`,
 * `expressionFields[i]`, via {@link screenRecordArray}) and the level BELOW it
 * ({@link isPresetFilterSafe}) both screened, and only the preset itself did not. Not
 * exploitable today — every rewrite of a preset uses spread/define semantics
 * (`docTransforms`' `renameFilterPreset` does `{ ...p, name }`) — but an own `"__proto__"`
 * DATA key round-trips through every autosave forever and poisons the first `Object.assign`
 * of a preset anyone writes. Drop the whole preset, matching the sibling entry screens.
 *
 * ABSENT NORMALIZES TO `[]`, NOT `undefined` — deliberately, and asymmetrically with the
 * factory and the reducer, which both leave `filterPresets` absent until a preset is saved.
 * `deserializeState` calls this unconditionally (`filterPresets:
 * screenFilterPresets(raw.filterPresets)`), and `serializeDoc` omits the field again when
 * empty, so the asymmetry is confined to an IN-MEMORY loaded doc and never reaches disk. The
 * observable consequence is only that `@mui/x-studio`'s `docTransforms.deleteFilterPreset` /
 * `renameFilterPreset` say a doc with no presets "is left as `undefined` (never manufactured
 * into an empty array)" — true for a factory doc, and vacuous for a loaded one, which already
 * carries `[]` before either function runs. Both still return the original `doc` reference in
 * that case, so no behaviour differs; documented here rather than aligned because
 * `statePersistence.test.ts` pins the `[]` normalization as the intended loaded shape and
 * changing it would be a persisted-shape change for no gain.
 */
export const screenFilterPresets = (value: unknown): StudioDoc['filterPresets'] => {
  if (!Array.isArray(value)) {
    return [];
  }
  let changed = false;
  const safe: unknown[] = [];
  for (const preset of value) {
    if (
      !isRecord(preset) ||
      hasUnsafeOwnKeys(preset) ||
      typeof preset.id !== 'string' ||
      !Array.isArray(preset.filters)
    ) {
      changed = true;
      continue;
    }
    const innerFilters = preset.filters;
    // Repair a malformed `dependsOn` (T2 finding) BEFORE the `isPresetFilterSafe` gate —
    // `dependsOn` is not one of that predicate's checks, and dropping the KEY rather than
    // rejecting the whole entry keeps a preset filter that is otherwise well-formed.
    const repairedInner = innerFilters.map((entry) => repairFilterDependsOn(entry));
    const safeInner = repairedInner.filter((entry) => isPresetFilterSafe(entry));
    const innerUnchanged =
      safeInner.length === innerFilters.length &&
      safeInner.every((entry, i) => entry === innerFilters[i]);
    const nameIsString = typeof preset.name === 'string';
    if (innerUnchanged && nameIsString) {
      safe.push(preset);
    } else {
      changed = true;
      safe.push({
        ...preset,
        name: safePresetName(preset.name),
        filters: safeInner,
      });
    }
  }
  return (changed ? safe : value) as StudioDoc['filterPresets'];
};

/** Screen `doc.relationships`: container + per-entry record/own-key/required-leaf checks. */
export const screenRelationships = (value: unknown): StudioDoc['relationships'] =>
  screenRecordArray<StudioDoc['relationships'][number]>(value, isRelationshipSafe);

/** Screen `doc.expressionFields`: container + per-entry record/own-key/required-leaf checks. */
export const screenExpressionFields = (value: unknown): StudioExpressionField[] =>
  screenRecordArray<StudioExpressionField>(value, isExpressionFieldSafe);

/**
 * Screen the four OPTIONAL widget scalars — delete a non-string `subtitle`/`sourceId` and a
 * non-`'auto'|'manual'` `titleMode`/`subtitleMode` — plus an unknown `config.chartType`.
 *
 * The ONE implementation, shared by the write boundary (`applyMutation`'s `addWidget` /
 * `applyBulkUpdate.addedWidgets`) and the doc screen below. The wire boundary's
 * `validateWidget` (`parseStateMutation.ts`) membership-checks all four — `subtitle`/
 * `sourceId` via `isOptionalString`, `titleMode`/`subtitleMode` via `isTitleModeValue` —
 * but a server-built add bypassing the parser reaches the reducer directly, and this screen
 * would then drop the offending KEY on the next load anyway: the value is discarded either
 * way, just deferred. Repairing at write time keeps the boundaries agreeing.
 *
 * `config.chartType` is screened HERE rather than only in `screenWidgets` for exactly that
 * reason. The reducer was the only one of the four trust boundaries with no `chartType`
 * membership screen, so one payload got three different answers: the wire boundary REJECTED
 * `config: { chartType: 'trendline' }`, the reducer installed it VERBATIM, and the next load
 * STRIPPED the key. That is the deferred-data-loss class — the widget renders blank, wedges
 * every later AI `update_widget` (`executeToolOnState` hard-errors on an unknown stored
 * chartType), then silently becomes a bar chart on the next reload. Folding it into this
 * shared screen makes both ADD channels agree with the load boundary by construction; the
 * three UPDATE channels get the same strip in `applyMutation.ts` via
 * `hasInvalidChartTypeInConfig`, the wire boundary's own predicate.
 *
 * Strips the KEY rather than sinking the whole widget (these fields are optional, so an
 * invalid value degrades to the field's default — `'auto'`, or `resolveChartType`'s `'bar'`).
 * Reference-stable when every screened field is valid or absent, the only shape the wire
 * boundary itself lets through.
 *
 * The two field lists are DERIVED from the compile-locked `StudioWidgetOf` partitions in
 * `widgetTypeGuards.ts`, so a new optional widget field cannot be added without this screen
 * (and its four siblings) following.
 */
export function screenOptionalWidgetScalars(widget: StudioWidget): StudioWidget {
  let base = widget;
  for (const modeKey of WIDGET_TITLE_MODE_FIELDS) {
    const modeValue = (base as unknown as Record<string, unknown>)[modeKey];
    if (!isTitleModeValue(modeValue)) {
      const nextBase = { ...base };
      delete (nextBase as unknown as Record<string, unknown>)[modeKey];
      base = nextBase as StudioWidget;
    }
  }
  for (const stringKey of OPTIONAL_WIDGET_STRING_FIELDS) {
    const stringValue = (base as unknown as Record<string, unknown>)[stringKey];
    if (stringValue !== undefined && typeof stringValue !== 'string') {
      const nextBase = { ...base };
      delete (nextBase as unknown as Record<string, unknown>)[stringKey];
      base = nextBase as StudioWidget;
    }
  }
  // `isRecord` guard: this screen is reached with a record `config` on all three call sites
  // (both reducer channels run `coerceWidgetConfig` first, and `screenWidgets` coerces a
  // non-record config to `{}` before calling), but a boundary screen must repair or no-op
  // rather than throw on `Object.hasOwn(null, …)`.
  const config = base.config as StudioWidgetConfig | undefined;
  if (
    isRecord(config) &&
    Object.hasOwn(config, 'chartType') &&
    !(typeof config.chartType === 'string' && isStudioChartType(config.chartType))
  ) {
    const nextConfig = { ...config };
    delete nextConfig.chartType;
    base = { ...base, config: nextConfig } as StudioWidget;
  }
  return base;
}

/**
 * Screen a `widgets` record: drop the entries no boundary downstream can repair, and repair
 * in place the ones that are salvageable. Per entry, in order:
 *
 *  - DROP a prototype-hazard record KEY, a non-record value, a widget carrying a
 *    prototype-hazard OWN key, one whose `config` carries one, or one whose `kind`/`title`
 *    is missing/non-string — each of these is exactly what the wire boundary's
 *    `validateWidget` rejects for the byte-identical payload.
 *  - RE-STAMP `id` from the record KEY. The reducer's every id-keyed lookup/delete/
 *    cross-filter-cleanup keys off the KEY, and BOTH the wire boundary and the reducer reject
 *    a `changes.id` precisely to keep `widget.id` in sync with it. A doc where the desync
 *    ALREADY exists (`widgets: { "w-a": { "id": "w-b", … } }`) would otherwise load verbatim
 *    and silently no-op every subsequent edit/delete of that widget, and a cross-filter it
 *    emits could never be cleaned up.
 *  - COERCE a non-record `config` to `{}`. A hand-edited `config: null` passes the
 *    record-widget check above and then installs a live widget whose first render throws
 *    (`config.chartType` off `null`) — and whose next config-touching mutation throws inside
 *    `shallowRecordEqual`.
 *  - STRIP an invalid optional scalar and an unknown `config.chartType` key, so the
 *    `'auto'`/`resolveChartType`-`'bar'` defaults apply instead.
 */
export function screenWidgets(value: unknown): StudioDoc['widgets'] {
  const source = (isRecord(value) ? value : {}) as StudioDoc['widgets'];
  return Object.fromEntries(
    Object.entries(source)
      .filter(([id, widget]) => {
        if (!(isSafeKey(id) && isRecord(widget))) {
          return false;
        }
        // Screen the widget object's OWN top-level keys against the prototype-hazard
        // denylist, symmetric with the wire boundary's
        // `hasUnsafeOwnKeys(widget)` rejection in `validateWidget`. `JSON.parse` on a
        // shared/hand-edited doc materializes an own `"__proto__"`/`"constructor"`/
        // `"prototype"` key as a real own DATA property (not the inherited accessor); such
        // a widget passes load verbatim today, round-trips through `serializeDoc`, and an
        // `Object.assign({}, loadedWidget)`/spread of it then poisons the target's
        // prototype.
        if (hasUnsafeOwnKeys(widget)) {
          return false;
        }
        // Same screen one level down on `config`: the reducer rebuilds config
        // key-by-key on later edits, so an unsafe own key there is a pollution hazard the
        // wire boundary rejects outright. Drop the whole widget rather than load a config
        // the wire boundary would refuse.
        const cfg = (widget as { config?: unknown }).config;
        if (isRecord(cfg) && hasUnsafeOwnKeys(cfg)) {
          return false;
        }
        // Both fields are load-bearing — the widget factory/renderer keys off `kind`, and
        // the canvas card renders `title` — and are read with no fallback, so a
        // hand-edited/foreign doc carrying `kind: 42` or an absent `title` would otherwise
        // load a widget the byte-identical wire payload is rejected for, and likely crash
        // on first render.
        if (
          typeof (widget as { kind?: unknown }).kind !== 'string' ||
          typeof (widget as { title?: unknown }).title !== 'string'
        ) {
          return false;
        }
        return true;
      })
      .map(([id, widget]) => {
        const rawConfig = (widget as { config?: unknown }).config;
        let base = widget;
        if (base.id !== id) {
          base = { ...base, id } as StudioWidget;
        }
        if (!isRecord(rawConfig)) {
          base = { ...base, config: {} } as StudioWidget;
        }
        // Also membership-checks the closed `chartType` union — that strip now lives INSIDE
        // `screenOptionalWidgetScalars` (it used to be a second block here) so the reducer's
        // two ADD channels, which call the same shared screen, get it too. See that
        // function's doc for why the reducer having no `chartType` screen was a
        // deferred-data-loss bug rather than a cosmetic asymmetry.
        base = screenOptionalWidgetScalars(base);
        return [id, base];
      }),
  ) as StudioDoc['widgets'];
}

/**
 * EXISTENCE screen for a filter's scope anchors: does every id the scope names actually
 * resolve against `doc`?
 *
 * This is the "Stage 2" half of filter screening — the half a payload-in-isolation validator
 * (the wire boundary's `validateFilterScope`) structurally cannot do, because it has no doc
 * to look ids up in. It is published as ONE predicate so every writer that installs a scope
 * enforces the identical rule: the reducer's `addFilter` (which calls it), and
 * `@mui/x-studio`'s `StudioController.updateFilter`, which re-points an EXISTING filter's
 * scope through `commitDocPatch` and therefore never reaches the reducer at all. Before this
 * was shared, `updateFilter` applied none of it — `updateFilter('f1', { scope: { kind:
 * 'widget', widgetId: 'nope' } })` was accepted live while the sibling `addFilter` with the
 * byte-identical scope was refused, and the load boundary then dropped the whole filter on
 * the next reload (deferred, silent data loss).
 *
 * Why an unresolvable anchor must not install: the reducer's only cleanup paths for a scoped
 * filter (`dropWidgetScopedFilters`, `removePage`'s page-anchor drop) fire when the anchor is
 * REMOVED. A filter anchored to something that never existed is never removed, so it filters
 * its page forever with no clearing affordance.
 *
 * "Exists" is the reducer's own notion — `Object.hasOwn` — so an untrusted id cannot match a
 * prototype member.
 *
 * Assumes `scope` already passed WELLFORMEDNESS (`isValidFilterScope`); callers run that
 * first. A `page` scope with no `pageId` (the legacy "applies on every page" shape) has no
 * anchor to resolve and passes.
 */
export function hasResolvableFilterAnchors(
  scope: StudioFilterScope,
  doc: Pick<StudioDoc, 'widgets' | 'pages'>,
): boolean {
  // WIDGET anchor: `widget`/`cross-filter`/`interactive` scopes name a widget that must
  // already exist.
  let widgetAnchorId: string | undefined;
  if (scope.kind === 'cross-filter' || scope.kind === 'interactive') {
    widgetAnchorId = scope.sourceWidgetId;
  } else if (scope.kind === 'widget') {
    widgetAnchorId = scope.widgetId;
  }
  if (widgetAnchorId !== undefined && !Object.hasOwn(doc.widgets, widgetAnchorId)) {
    return false;
  }
  // PAGE anchor, the mirror of the widget one. All four `pageId`-bearing scope kinds are
  // covered; `page` scope's `pageId` is optional, so the `!== undefined` gate leaves the
  // legacy shape alone.
  if (
    (scope.kind === 'page' ||
      scope.kind === 'dashboard-date-range' ||
      scope.kind === 'cross-filter' ||
      scope.kind === 'interactive') &&
    scope.pageId !== undefined &&
    !Object.hasOwn(doc.pages, scope.pageId)
  ) {
    return false;
  }
  return true;
}

/**
 * Optional anchor-existence probes for {@link screenFilters}. Supplied only by the
 * PERSISTENCE load boundary, which has already swept the page map and the widget record and
 * can therefore tell an orphan anchor from a live one. The in-process producers
 * (`createDefaultStudioState`) deliberately pass none: their `pages`/`widgets` are merged
 * onto the factory defaults AFTER this screen runs, so a filter anchored to the default page
 * would look like an orphan here and be wrongly dropped.
 */
export interface FilterAnchorProbes {
  hasPage: (pageId: string) => boolean;
  hasWidget: (widgetId: string) => boolean;
}

/** Options for {@link screenFilters}. */
export interface ScreenFiltersOptions {
  /**
   * Drop `cross-filter`- and `interactive`-scoped entries. Only the PERSISTENCE load
   * boundary sets this: those two kinds are session-flavoured and never written to disk
   * (`serializeDoc` strips them), so one arriving from a hand-edited or foreign doc must not
   * install — an orphaned cross-filter would permanently filter its page, since the
   * reducer's cleanup for it only fires when the source widget is REMOVED and it was never
   * present. In-process producers legitimately BUILD live state carrying both kinds, so the
   * default is to keep them.
   */
  stripSessionScopes?: boolean;
  /** See {@link FilterAnchorProbes}. */
  anchors?: FilterAnchorProbes;
}

/**
 * Screen a `filters` array: repair a malformed `dependsOn`, then drop every entry that
 * cannot survive as a live filter.
 *
 * DEDUP ORDERING IS LOAD-BEARING. The `id` is CLAIMED only at the very END of the screen,
 * after every drop-check has passed — never at the point the duplicate test runs. Claiming
 * early meant an entry that was subsequently DROPPED had already consumed its id, so a doc
 * carrying two filters with id `f1` — the first cross-filter-scoped (stripped), the second a
 * perfectly valid page filter — lost BOTH, and the next autosave persisted the loss. The
 * sibling `ai.threads` dedup in {@link screenAIState} orders it the same way.
 *
 * Reference-stable in the entries (a surviving well-formed filter keeps its identity); the
 * array itself is always a fresh `.filter` result.
 */
export function screenFilters(value: unknown, options?: ScreenFiltersOptions): StudioFilterState[] {
  const source = (Array.isArray(value) ? value : []) as StudioFilterState[];
  // Repair a malformed `dependsOn` (T2 finding) BEFORE the structural screen below:
  // `dependsOn` is optional cascade metadata, not identity data, so a malformed value
  // (`dependsOn: 'w1'`, `dependsOn: [1, 2]`) is stripped from the filter object rather than
  // sinking the whole entry — mirroring how a bad widget `titleMode` key is stripped rather
  // than dropping the whole widget. Left unrepaired, the malformed field would load
  // successfully and later crash `StudioFiltersDrawer`'s `dependsOn.map(...)` the first time
  // the filter rendered.
  const repaired = source.map((f) => repairFilterDependsOn(f));
  const seenFilterIds = new Set<string>();
  return repaired.filter((f) => {
    if (!isRecord(f)) {
      return false;
    }
    // Screen the filter object's OWN keys against the prototype-hazard denylist (Finding
    // T2-2), symmetric with the wire boundary's `hasUnsafeOwnKeys` gate in `validateFilter`.
    // The reducer's `addFilter` appends a filter verbatim (`[...state.filters, args.filter]`),
    // and `JSON.parse` on a shared/hand-edited doc materializes an own `"__proto__"` key as a
    // real own DATA property.
    if (hasUnsafeOwnKeys(f)) {
      return false;
    }
    // Drop a filter whose `id` is not a string, symmetric with the wire
    // boundary's `isSafeId(filter.id)` gate. A non-string `id` (a hand-edited `id: 42`) can
    // NEVER be matched by wire `removeFilter` (whose `f.id !== filterId` compares against a
    // string), so it would install a permanently-unremovable filter.
    if (typeof (f as { id?: unknown }).id !== 'string') {
      return false;
    }
    // Drop a duplicate `id` — first occurrence already kept. Runs after the
    // string-id screen above so a non-string id never poisons the `seen` set. See this
    // function's doc comment for why the CLAIM happens at the end instead of here.
    const filterId = (f as { id: string }).id;
    if (seenFilterIds.has(filterId)) {
      return false;
    }
    const scope = (f as { scope?: unknown }).scope;
    // Full scope validity — record-ness, kind membership AND every required id field present
    // — via the ONE shared predicate the wire boundary uses. An unknown kind
    // like `'pages'` would otherwise load as a permanent inert entry that escapes
    // `removePage`/`dropWidgetScopedFilters` cleanup (both key off the known kinds); a scope
    // missing a required id (e.g. a `dashboard-date-range` without `sourceId`, which would
    // mis-apply a date window) is dropped here exactly as the wire boundary rejects the
    // byte-identical payload. `isValidFilterScope` also rejects a scope carrying an own
    // `__proto__`/`constructor`/`prototype` key.
    //
    // This is the check that fires for the traced `initialState` crash: a filter with NO
    // `scope` at all threw `TypeError` inside `serializeDoc` (`f.scope.kind`) on the first
    // autosave and on every undo snapshot.
    if (!isValidFilterScope(scope)) {
      return false;
    }
    if (
      options?.stripSessionScopes &&
      (scope.kind === 'cross-filter' || scope.kind === 'interactive')
    ) {
      return false;
    }
    const anchors = options?.anchors;
    // Drop a filter anchored to a `pageId` that no longer exists — the PAGE-anchor mirror of
    // the widget-anchor check just below. A `page`-scoped filter with an explicit `pageId`,
    // or a `dashboard-date-range` filter (whose `pageId` is required), naming a page the doc
    // doesn't contain would otherwise be permanent dead weight with no clearing affordance:
    // the reducer's page-anchor cleanup (`removePage`'s `filtersAfterPageDrop`) only runs for
    // a LIVE `removePage` mutation, never for a doc that already lacks the page. A
    // `page`-scoped filter with NO `pageId` (the legacy "applies on every page" shape) is
    // left alone. `isValidFilterScope` above already string-checked both `pageId` fields, so
    // the numeric-id-coerces-to-a-matching-string-key class of bug cannot reach the probe.
    if (
      anchors !== undefined &&
      (scope.kind === 'page' || scope.kind === 'dashboard-date-range') &&
      scope.pageId !== undefined &&
      !anchors.hasPage(scope.pageId)
    ) {
      return false;
    }
    // Drop an ORPHAN `widget`-scoped filter whose `widgetId` names no loaded widget,
    // symmetric with the reducer's `addFilter` guard. Its only cleanup path
    // (`dropWidgetScopedFilters`) fires on widget REMOVAL, which never happens for a widget
    // that was never present, so it would otherwise be permanent invisible dead weight that
    // filters its page forever.
    if (anchors !== undefined && scope.kind === 'widget' && !anchors.hasWidget(scope.widgetId)) {
      return false;
    }
    // Field-is-a-string check, symmetric with the wire boundary: a junk `field: 42`
    // would install an active-but-unevaluable filter that silently renders every widget in
    // scope empty.
    const record = f as { field?: unknown; operator?: unknown; operator2?: unknown };
    if (typeof record.field !== 'string') {
      return false;
    }
    // Membership-check the closed `operator` union, symmetric with the wire
    // boundary's `isStudioFilterOperator` gate: a hand-edited `operator: 'equal'` (a
    // plausible typo for `'equals'`) would otherwise install a chip that renders as ACTIVE
    // while filtering nothing — a silent fail-open. A present `operator2` is held to the same
    // membership check (absent stays legal).
    if (!isStudioFilterOperator(record.operator)) {
      return false;
    }
    if (record.operator2 !== undefined && !isStudioFilterOperator(record.operator2)) {
      return false;
    }
    // The entry SURVIVED every screen, so it may now claim its id.
    seenFilterIds.add(filterId);
    return true;
  });
}

/**
 * Screen `doc.ai`: keep it only when it is a record whose `threads` is an array, AND screen
 * each thread ENTRY — not just the container. `renameAIThread` does
 * `(state.ai.threads ?? []).map((t) => t.id …)` with NO optional chaining, so a
 * `threads: [null, {…}]` that passes the container `Array.isArray` check still throws
 * `Cannot read properties of null (reading 'id')` on the first rename, and `serializeDoc`
 * re-persists the junk verbatim (`threads.length > 0`). A non-array `threads` (the traced
 * `ai.threads: 'junk'` `initialState` crash) drops the whole `ai` to `undefined`.
 *
 * Also screens the `ai` container AND each surviving thread for prototype-hazard OWN keys:
 * `renameAIThread` spreads both (`{ ...state.ai, threads: … }`, `{ ...t, name }`).
 * The container's unsafe keys are stripped (keeping the rest of `ai`); a thread carrying one
 * is dropped whole, matching the sibling per-entry own-key screens.
 *
 * A dangling `activeThreadId` is reconciled to `undefined` (no thread selected) — NOT the
 * first surviving thread: unlike `dashboard.activePageId` (a page must always be rendered),
 * `activeThreadId?: string` already means "no thread selected", so clearing it is a safe,
 * already-handled state rather than guessing which thread the user meant.
 *
 * Reference-stable: returns the SAME `ai` object when nothing was dropped, repaired or
 * reconciled.
 */
export function screenAIState(value: unknown): StudioAIState | undefined {
  if (!isRecord(value) || !Array.isArray((value as unknown as StudioAIState).threads)) {
    return undefined;
  }
  const ai = stripUnsafeOwnKeys(value as unknown as StudioAIState);
  // `aiChanged` tracks every drop/repair below (entries, ids, dedup, AND the
  // `activeThreadId` reconciliation) so a well-formed `ai` keeps its reference identity.
  let aiChanged = false;
  const recordThreads = ai.threads.filter((thread) => {
    if (!isRecord(thread) || hasUnsafeOwnKeys(thread)) {
      aiChanged = true;
      return false;
    }
    return true;
  });
  // Drop a thread whose `id` is not a non-empty string (Tier2 finding — the `ai.threads`
  // sibling of the `filters` `typeof f.id !== 'string'` screen above): `id` is identity data,
  // and `renameAIThread`'s `t.id === threadId` lookup (and the `activeThreadId`
  // reconciliation below) compares against a STRING, so a non-string `id` would load as a
  // permanently-unselectable, unrenamable thread with no error. Also de-dup by `id`, first
  // occurrence wins (mirroring the `filters` dedup, Finding 3).
  const seenThreadIds = new Set<string>();
  const idScreenedThreads = recordThreads.filter((thread) => {
    const id = (thread as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0) {
      aiChanged = true;
      return false;
    }
    if (seenThreadIds.has(id)) {
      aiChanged = true;
      return false;
    }
    seenThreadIds.add(id);
    return true;
  });
  const safeThreads = idScreenedThreads.map((thread) => {
    const repairedThread = repairThreadLeafShapes(thread);
    if (repairedThread !== thread) {
      aiChanged = true;
    }
    return repairedThread;
  });
  const activeThreadIdValid =
    typeof ai.activeThreadId === 'string' &&
    safeThreads.some((t) => (t as { id: string }).id === ai.activeThreadId);
  if (!activeThreadIdValid && ai.activeThreadId !== undefined) {
    aiChanged = true;
  }
  if (!aiChanged) {
    return ai;
  }
  const rebuilt: StudioAIState = { ...ai, threads: safeThreads };
  if (!activeThreadIdValid) {
    delete rebuilt.activeThreadId;
  }
  return rebuilt;
}

/**
 * Screen `doc.dashboard`: strip prototype-hazard OWN keys and coerce a missing/non-string
 * `title`/`id` to the same fallbacks `createDefaultStudioState` stamps.
 *
 * Both fields are REQUIRED by `StudioDashboardState` but neither is checked by
 * `migrateState`'s `findMissingRequiredField` (which only validates that `dashboard` is a
 * record), so a `dashboard: {}` loaded with `doc.dashboard.id === undefined` — a type
 * violation the rest of the system reads as a string (it keys saved-view/telemetry records
 * and is interpolated into ids) and which `serializeDoc` then re-persisted forever. A junk
 * `title` crashes the first component that renders it as text.
 *
 * `activePageId` is deliberately NOT reconciled here: that needs the FINAL page map, which
 * each caller assembles differently (the load boundary sweeps and may synthesize a default
 * page; the factory merges onto its own default). Both callers do it themselves.
 * Reference-stable when nothing needed fixing.
 */
export function screenDashboard(value: unknown): StudioDoc['dashboard'] {
  const record = (isRecord(value) ? value : {}) as unknown as StudioDoc['dashboard'];
  const stripped = stripUnsafeOwnKeys(record);
  const safeTitle = typeof stripped.title === 'string' ? stripped.title : 'Untitled Dashboard';
  const safeId = typeof stripped.id === 'string' ? stripped.id : 'dashboard-1';
  if (safeTitle === stripped.title && safeId === stripped.id) {
    return stripped;
  }
  return { ...stripped, id: safeId, title: safeTitle };
}

/**
 * Screen the SHAPE of a `pages` record: coerce a non-record `pages` to `{}`, and drop a
 * prototype-hazard page KEY, a non-record page VALUE, and a page carrying a
 * prototype-hazard OWN key.
 *
 * This is deliberately the shape-only SUBSET of `normalizePersistedPages`
 * (`applyMutation.ts`), which additionally sweeps `widgetRows`/`widgetColSpans`, re-stamps
 * `page.id` from the record key and coerces `page.title`. Those steps need the layout
 * primitives and are therefore out of this module's reach (see the import-cycle note at the
 * top of this file); the load boundary calls the full sweep directly. What lives here is
 * exactly what closes the CRASHES, and it needs no import this module cannot have.
 *
 * `pages` used to be skipped by `screenDoc` entirely, which made it the ONE `StudioDoc`
 * field where an override could make a boundary THROW rather than repair — the deliberate
 * exception the repair convention allows is a doc claiming a newer `schemaVersion`, nothing
 * else. Three reachable throws, all through the public `Studio initialState` prop:
 *  - `{ doc: { pages: undefined } }` (which type-checks: `Partial<StudioDoc>` accepts an
 *    explicit `undefined`) → `TypeError: Cannot convert undefined or null to object` from
 *    the factory's own `Object.keys(mergedDoc.pages)` zero-page check;
 *  - `{ doc: { pages: { p1: null } } }` plus any widget-scoped rank filter →
 *    `Cannot read properties of null (reading 'widgetRows')` from `resolveRankFilterPageId`,
 *    via the factory's `dedupeRankFilters` sweep. The load boundary is immune only because
 *    `normalizePersistedPages` drops the null page BEFORE that sweep runs;
 *  - `{ doc: { pages: 'junk' } }` installed the string AS the page map (with
 *    `activePageId: '0'`, its first "key"), and the reducer then threw on the first
 *    `addWidget`.
 *
 * Reference-STABLE: returns the SAME record when every page survives.
 */
export function screenPagesShape(value: unknown): StudioDoc['pages'] {
  if (!isRecord(value)) {
    return {} as StudioDoc['pages'];
  }
  const source = value as StudioDoc['pages'];
  const entries = Object.entries(source);
  const kept = entries.filter(
    ([pageId, page]) => isSafeKey(pageId) && isRecord(page) && !hasUnsafeOwnKeys(page),
  );
  if (kept.length === entries.length) {
    return source;
  }
  return Object.fromEntries(kept) as StudioDoc['pages'];
}

/**
 * Run every screen above over a PARTIAL `StudioDoc`, touching only the fields the bag
 * actually carries.
 *
 * The "only present keys" rule is what makes this safe for `createDefaultStudioState`, whose
 * documented merge contract is that an ABSENT override field keeps the factory default: if
 * this stamped `filters: []`/`ai: undefined` onto a bag that named neither, it would change
 * the shape of every default doc in the codebase.
 *
 * `pages` gets only the SHAPE screen ({@link screenPagesShape}); the full layout sweep is
 * `normalizePersistedPages` in `applyMutation.ts`, which this module cannot import (see the
 * import-cycle note at the top of this file). The load boundary calls that one directly, so
 * the factory's `pages` override remains unswept for layout — a documented gap — but can no
 * longer make a boundary throw.
 */
export function screenDoc(doc: Partial<StudioDoc> | undefined): Partial<StudioDoc> | undefined {
  if (doc === undefined) {
    return doc;
  }
  if (!isRecord(doc)) {
    return {};
  }
  const next: Record<string, unknown> = { ...doc };
  if (Object.hasOwn(doc, 'dashboard')) {
    next.dashboard = screenDashboard(doc.dashboard);
  }
  if (Object.hasOwn(doc, 'pages')) {
    next.pages = screenPagesShape(doc.pages);
  }
  if (Object.hasOwn(doc, 'widgets')) {
    next.widgets = screenWidgets(doc.widgets);
  }
  if (Object.hasOwn(doc, 'filters')) {
    next.filters = screenFilters(doc.filters);
  }
  if (Object.hasOwn(doc, 'relationships')) {
    next.relationships = screenRelationships(doc.relationships);
  }
  if (Object.hasOwn(doc, 'expressionFields')) {
    next.expressionFields = screenExpressionFields(doc.expressionFields);
  }
  if (Object.hasOwn(doc, 'filterPresets')) {
    next.filterPresets = screenFilterPresets(doc.filterPresets);
  }
  if (Object.hasOwn(doc, 'ai')) {
    next.ai = screenAIState(doc.ai);
  }
  return next as Partial<StudioDoc>;
}
