/**
 * Runtime validation boundary for a `StateMutation` that arrives from OUTSIDE the
 * process that produced it.
 *
 * `applyMutation` (`applyMutation.ts`) is the single shared reducer both the client
 * (`@mui/x-studio`) and the server (`@mui/x-studio-ai-middleware`) run, and its
 * handlers destructure `mutation.args` trusting the compile-time `StateMutation`
 * shape. TypeScript cannot enforce that shape on a value that crossed a wire
 * boundary (an SSE payload that was `JSON.parse`'d), so a malformed payload can
 * reach a handler and corrupt state — e.g. a `setWidgetLayout` whose `rows` is the
 * wrong shape persists a broken layout through `serializeState`, and an
 * `applyBulkUpdate` `addedWidgets` entry with `id: '__proto__'` triggers prototype
 * pollution via the reducer's `nextWidgets[widget.id] = widget` bare assignment.
 *
 * `parseStateMutation` is the ONE place a value CLAIMING to be a `StateMutation` is
 * checked before it is handed to `applyMutation`. There is exactly one such trust
 * boundary in the codebase: the client's SSE `state-mutation` event handler
 * (`@mui/x-studio`'s `StudioBackendAdapter` → `applyStateMutation`). Every
 * `StateMutation` that reaches `applyMutation` server-side is constructed by the
 * server itself (`executeToolOnState.ts`) and never deserialized from client input,
 * so it does not pass through here.
 *
 * The design principle mirrors `resolveAlias` in
 * `@mui/x-studio-data-middleware`'s `shared/columnValidation.ts`: one shared
 * implementation of the check rather than independently-drifting inline validation
 * at each call site — see that file's doc comment for the fuller rationale.
 */
import type { StateMutation } from './aiTypes';
import type { StudioFilterScope } from './stateTypes';
import { validateConfigKeysForKind } from './configKeyValidation';
import {
  isStudioChartType,
  isStudioFilterOperator,
  isTitleModeValue,
  STUDIO_FILTER_OPERATORS,
  WIDGET_STRING_FIELDS,
  WIDGET_TITLE_MODE_FIELDS,
} from './widgetTypeGuards';
import { UNSAFE_KEYS, isSafeKey } from './unsafeKeys';
import { isPlainRecord as isRecord } from './internalGuards';
import { MAX_ARRAY_LENGTH, MAX_STRING_LENGTH } from './wireLimits';

export type ParseStateMutationResult =
  | { ok: true; mutation: StateMutation }
  | { ok: false; error: string };

// ── Wire trust-boundary size caps (Tier2 finding) ───────────────────────────────
//
// Everything above validated SHAPE only — an array or string field of unbounded
// length still passed as long as its elements were individually shape-valid: an
// `addedWidgets` array with 500,000 entries, or a widget `title` several megabytes
// long, both satisfied every check below this comment before this fix. This file's
// own module doc calls it out as "the ONE place a value CLAIMING to be a
// `StateMutation` is checked" from OUTSIDE the process — the reducer, the client's
// React render tree, and `serializeState`'s JSON payload all assume a bounded,
// dashboard-sized document, so an unbounded payload can hang/OOM a consumer well
// before any shape check would reject it.
//
// These are deliberately generous, conservative caps — far beyond anything a real
// dashboard-editing UI or AI tool call would ever approach — not tight limits tuned
// to an exact legitimate maximum. Applied inside the shared leaf predicates
// (`isString`-family, `isStringArray`, `isStringMatrix`, `isFiniteNumberRecord`) so
// every field that already routes through them (ids, titles, `dependsOn`,
// `unsetFields`/`unsetConfigKeys`, `rowWidgetIds`, `removedWidgetIds`, the
// `rows`/`widgetRows` layout matrix, `widgetColSpans`) is capped uniformly, plus
// explicit checks with a more specific message at the two record-array collections
// (`addedWidgets`/`updatedWidgets`) that are validated by a per-entry loop rather
// than one of the shared array predicates.
//
// `MAX_ARRAY_LENGTH`/`MAX_STRING_LENGTH` live in `wireLimits.ts`, not here, so
// `internalGuards.ts`'s `repairFilterDependsOn` (the reducer/load-boundary defense-in-depth
// repair for `dependsOn`, reachable by paths that never pass through this file) enforces the
// SAME caps rather than being unbounded.

// The caps above are BREADTH-only, and they are applied only to the fields routed through
// the shared leaf predicates. Two gaps remained (Tier2 finding), both reachable with a
// payload of a few kilobytes:
//
//  - No DEPTH bound. `config`'s interior is a deliberately-unvalidated leaf (see
//    `validateWidget`), and `hasUnsafeOwnKeys` only inspects TOP-LEVEL keys, so an
//    `addWidget` with `config: { chartType: 'bar', customConfig: <10,000-deep nested
//    array> }` passed every check — `customConfig` is an allowed shared config key, and the
//    payload is small enough that no length cap fires. It installed into `doc.widgets`, and
//    then the host's autosave `JSON.stringify(serializeState(state))` threw `RangeError:
//    Maximum call stack size exceeded`, so every save failed for the rest of the session
//    while the dashboard still looked fine. On the next schema bump `migrateState`'s
//    `structuredClone` hits the same limit and fails closed, making the doc unloadable.
//  - No bound at all on `filter.value`/`value2`, the other deliberately-unvalidated leaf,
//    which is the identical vector via `addFilter`.
//
// `isBoundedValue` closes both with ONE shared predicate, rather than an open-coded check
// per site. Like the caps above it is deliberately generous: 32 levels is far beyond any
// real widget config or filter value, but far below the recursion limit of
// `JSON.stringify`/`structuredClone`.
//
// It is applied to each WHOLE RECORD that crosses this boundary and is installed verbatim
// by the reducer (a widget, a filter, a filter scope), not only to the leaves the
// validators happen to name. That is load-bearing: those validators deliberately tolerate
// unknown extra own keys for forward compatibility (see `MutationArgValidator`), so a
// per-leaf list can always be out-run by one more unnamed key — `addWidget` with
// `widget: { …, extra: <20,000-deep nested array> }` carries the identical payload as an
// unbounded `config` and lands in `doc.widgets` all the same. Bounding the record itself
// costs strictly less than the per-leaf walks it subsumes and cannot be out-run.
const MAX_DEPTH = 32;
// Own-key cap for a record leaf, mirroring `isFiniteNumberRecord`'s existing key-count cap
// (and `MAX_ARRAY_LENGTH` for arrays): breadth and depth both need a bound, since a wide-
// but-shallow record is the same denial-of-service payload by another shape.
const MAX_RECORD_KEYS = MAX_ARRAY_LENGTH;

/**
 * True when `value` is a bounded, dashboard-sized JSON leaf: no deeper than
 * {@link MAX_DEPTH} levels, no array longer than {@link MAX_ARRAY_LENGTH}, no record with
 * more than {@link MAX_RECORD_KEYS} own keys, and no string (value OR key) longer than
 * {@link MAX_STRING_LENGTH}.
 *
 * Deliberately shape-AGNOSTIC — it makes no claim about what the value MEANS, only that a
 * consumer can `JSON.stringify`/`structuredClone`/render it without blowing a stack or a
 * memory budget. That is exactly the property `widget.config`, `filter.value` and every
 * unknown extra own key need: the boundary's whole design is that their interiors are not
 * interpreted here (deep-validating them would drift on every config change for no safety
 * gain, and unknown keys exist precisely so a newer server can add fields), but "not
 * interpreted" must not mean "not bounded".
 *
 * `depth` counts nesting levels of the value passed in, so a caller checking a record
 * field passes the default `0` for that record itself.
 */
function isBoundedValue(value: unknown, depth: number = 0): boolean {
  if (depth > MAX_DEPTH) {
    return false;
  }
  if (typeof value === 'string') {
    return value.length <= MAX_STRING_LENGTH;
  }
  if (value === null || typeof value !== 'object') {
    return true;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_ARRAY_LENGTH && value.every((item) => isBoundedValue(item, depth + 1))
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  return (
    keys.length <= MAX_RECORD_KEYS &&
    keys.every((key) => key.length <= MAX_STRING_LENGTH && isBoundedValue(record[key], depth + 1))
  );
}

/**
 * The shared error string for an unbounded leaf, so every call site reports the rejection
 * identically (and a new call site cannot invent a divergent message).
 */
function unboundedValueError(path: string): string {
  return (
    `${path} is not a bounded, dashboard-sized value, so storing it would break every ` +
    `later JSON.stringify/structuredClone of the document (autosave and schema migration ` +
    `both fail closed once it is installed). Send a value that nests no deeper than ` +
    `${MAX_DEPTH} levels, with no array longer than ${MAX_ARRAY_LENGTH} entries, no object ` +
    `with more than ${MAX_RECORD_KEYS} keys, and no string longer than ${MAX_STRING_LENGTH} characters`
  );
}

// ── Shared leaf predicates ──────────────────────────────────────────────────────

// `isRecord` (a plain object — not `null`, not an array — that everything the wire
// carries as an `args` bag, a widget, a filter, or a scope must satisfy) is the shared
// `isPlainRecord` from `internalGuards.ts`, aliased to this file's
// established local name so every existing call site below is unchanged.

// Caps every string leaf at `MAX_STRING_LENGTH` (Tier2 finding): a value can be
// shape-valid (a real string) yet still be an unbounded-length denial-of-service
// payload — a widget `title`/filter `field`/page `title` etc. has no legitimate
// reason to approach this cap.
function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH;
}

/** Absent (`undefined`) is fine; if present it must be a string. Used for every
 *  optional string field so a missing optional field never rejects a valid payload. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_STRING_LENGTH);
}

/**
 * A string id that is safe to use as an object key via a bare bracket assignment
 * (`record[id] = value`).
 *
 * This is what closes the prototype-injection bug: the reducer inserts widgets with
 * `nextWidgets[widget.id] = widget` (a `[[Set]]`, which invokes the inherited
 * `__proto__` setter), so an untrusted `id: '__proto__'` would rewrite the record's
 * prototype instead of adding an own key. Rejecting `'__proto__'`, `'constructor'`,
 * and `'prototype'` here means no accepted mutation can carry an id that pollutes a
 * `Record` the reducer writes to. Applied to EVERY id that ends up as such a key
 * (widget ids, `updatedWidgets[].widgetId`, `addPage.id`, `activePageId`, etc.).
 */
function isSafeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_STRING_LENGTH && isSafeKey(value);
}

/** A real `string[]` — `Array.isArray` first, so the string `"abc"` (which is
 *  iterable char-by-char) can never masquerade as `['a','b','c']`. Also capped at
 *  `MAX_ARRAY_LENGTH` entries, each no longer than `MAX_STRING_LENGTH` (Tier2
 *  finding): every field routed through this predicate (`dependsOn`, `unsetFields`,
 *  `unsetConfigKeys`, `rowWidgetIds`, `removedWidgetIds`) is a producer-controlled
 *  list with no legitimate reason to approach either cap.
 *
 *  Exported for `applyMutation.ts`, its one consumer, which needs the same array-shape
 *  check on `unsetFields`/`unsetConfigKeys` that this file applies on the way in.
 *
 *  The load boundary does NOT import this: `statePersistence.ts` reaches the same
 *  `dependsOn` verdict through `internalGuards.repairFilterDependsOn`, which checks the
 *  array-shape and size conditions directly rather than calling here — `internalGuards.ts`
 *  cannot import this module (`parseStateMutation.ts` imports IT, for `isPlainRecord`), so
 *  that would cycle. The two agree because both read the SAME `MAX_ARRAY_LENGTH`/
 *  `MAX_STRING_LENGTH` from `wireLimits.ts`, not because they share this function. */
export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ARRAY_LENGTH &&
    value.every((item) => typeof item === 'string' && item.length <= MAX_STRING_LENGTH)
  );
}

/** A `string[][]` (used by `setWidgetLayout.rows`/`applyBulkUpdate.widgetRows`).
 *  Every element must itself be a real `string[]`, so a mixed-depth value such as
 *  `[['a'], 'b']` is rejected rather than the `'b'` slipping through. Capped at
 *  `MAX_ARRAY_LENGTH` outer rows (each inner row already capped, transitively, by
 *  `isStringArray`'s own `MAX_ARRAY_LENGTH`/`MAX_STRING_LENGTH` checks — Tier2
 *  finding): a layout with more rows than a dashboard could ever render is rejected
 *  here rather than allocated. */
function isStringMatrix(value: unknown): value is string[][] {
  return Array.isArray(value) && value.length <= MAX_ARRAY_LENGTH && value.every(isStringArray);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A `Record<string, number>` with every value a finite number
 *  (used by `applyBulkUpdate.widgetColSpans`). Capped at `MAX_ARRAY_LENGTH` own
 *  keys, each no longer than `MAX_STRING_LENGTH` (Tier2 finding): a span map keyed
 *  by widget id has no legitimate reason to carry more entries, or longer keys,
 *  than any other id-collection in this file. */
function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length <= MAX_ARRAY_LENGTH &&
    keys.every((key) => key.length <= MAX_STRING_LENGTH) &&
    Object.values(value).every((v) => isFiniteNumber(v))
  );
}

/**
 * True when `record` carries one of the prototype-polluting keys as an OWN property.
 * The reducer rebuilds `updateWidget.config`/`changes` and `applyBulkUpdate`'s
 * `widgetColSpans` key-by-key, so a payload carrying `__proto__` as a real own key
 * (e.g. `JSON.parse('{"__proto__":…}')`, where it IS an own property rather than the
 * prototype accessor) is rejected here at the wire boundary. The reducer's own
 * `isSafePatchKey` guard is the defense-in-depth backstop for server-built mutations.
 *
 * Exported so the persistence LOAD boundary (`statePersistence.ts`'s `deserializeState`)
 * and the reducer (`applyMutation.ts`) can reuse the identical predicate when screening a
 * persisted widget/page/filter object's own keys, or a persisted widget's `config` own
 * keys, keeping the wire and load boundaries byte-for-byte in
 * agreement rather than re-implementing the denylist check. The parameter is the wide
 * `object` (not `Record<string, unknown>`) precisely so every boundary can pass its own
 * concrete shape — a `StudioWidget`, `StudioPage`, `StudioFilterState`, or a raw wire
 * `Record` — without a cast; the body only reads own key NAMES, never values.
 */
export function hasUnsafeOwnKeys(record: object): boolean {
  return Object.keys(record).some((key) => UNSAFE_KEYS.has(key));
}

/**
 * True when `config` carries an own `chartType` key whose value is present
 * (not `undefined`) but is not a member of the closed `StudioChartType` union —
 * e.g. `chartType: 'trendline'` or a non-string like `chartType: 42`.
 *
 * The full-widget create path (`validateWidget`, used by
 * `addWidget`/`applyBulkUpdate.addedWidgets`) already requires an explicit
 * `config.chartType` to pass `isStudioChartType`, but the three UPDATE-shaped
 * config-carrying channels (`updateWidget.args.config`,
 * `updateWidget.args.changes.config`, `applyBulkUpdate.args.updatedWidgets[].config`)
 * left `config`'s entire interior — including `chartType` itself — as an
 * unchecked leaf. This closes only the MEMBERSHIP gap, mirroring
 * `validateWidget`'s own membership check verbatim: it needs no resolved widget
 * kind/existing-widget state, unlike the (genuinely stateful) chart-family-key
 * check, which stays out of scope for a bare patch. `chartType: undefined` stays
 * legal — it is the sanctioned patch-delete of the key.
 *
 * Exported so `applyMutation.ts` applies the SAME membership test to the SAME three
 * update-shaped channels. The reducer was the only one of the four trust boundaries with
 * no `chartType` screen at all, so one payload got three different answers (wire: reject,
 * reducer: install verbatim, load: strip the key) — the deferred-data-loss class. Sharing
 * this predicate rather than re-spelling it is what stops the wire boundary and the reducer
 * disagreeing about which chart types exist.
 */
export function hasInvalidChartTypeInConfig(config: Record<string, unknown>): boolean {
  if (!Object.hasOwn(config, 'chartType') || config.chartType === undefined) {
    return false;
  }
  return !isString(config.chartType) || !isStudioChartType(config.chartType);
}

// ── Nested-structure validators ─────────────────────────────────────────────────

/**
 * Shallow validation of a `StudioWidget` embedded in `addWidget`/`applyBulkUpdate`.
 * `id` must be a safe id (it becomes a `Record` key), `kind`/`title` must be
 * strings, and `config` must be a plain object — but the config's per-kind interior
 * is deliberately NOT deep-validated: its many per-kind shapes are a leaf payload
 * the reducer never keys/iterates on, and deep-validating them here would drift on
 * every widget-config change for no safety gain.
 *
 * A chart config carrying keys from ANOTHER chart family is PRESERVED — neither rejected
 * nor stripped. Retention-across-chartType-switch is a documented, permanent feature of
 * `StudioChartConfig` (see its doc in `widgetTypes.ts`): a user who flips a bar chart to a
 * gauge and back must get their `xField`/`yAggregation` back, so a stored chart config
 * legitimately carries keys authored under a previously-selected chartType.
 *
 * This validator used to REWRITE `widget.config` in place to its effective family's keys
 * (via `stripForeignFamilyKeys`), which put three boundaries in disagreement about one
 * `addWidget` payload: `deserializeState` PRESERVES foreign-family keys, `applyMutation`'s
 * config merge PRESERVES them, and only the wire boundary deleted them. Round-tripping a
 * stored widget through `addWidget`/`applyBulkUpdate.addedWidgets` (duplicating it, moving
 * it across dashboards) therefore silently destroyed exactly the retained keys the feature
 * exists to keep. Preserving is what makes all three agree, and it is the semantics the
 * other two — and the feature itself — already had. Latent rather than live: the only
 * current producer (`buildWidgetFromArgs` in `@mui/x-studio-ai-middleware`) rejects a
 * foreign-family key before the strip could fire.
 *
 * "Not a chart key at all" stays fatal — the kind-level `validateConfigKeysForKind` check
 * above rejects any key outside the union of every chart family — as does an explicit
 * `chartType` that is not a real `StudioChartType`. Only the FAMILY distinction is soft.
 *
 * The whole widget record is bounded (see `isBoundedValue`) as the last step: unknown
 * extra own keys are tolerated for forward compatibility and the reducer installs the
 * widget object verbatim, so the record-level bound is the only thing that holds for a
 * key this function does not name.
 */
function validateWidget(widget: unknown, path: string): string | null {
  if (!isRecord(widget)) {
    return `${path} must be an object`;
  }
  // Screen the widget object's OWN top-level keys for the prototype-hazard denylist,
  // symmetric with the `updateWidget.args.changes` check below — the only
  // other place a wholesale widget object crosses the wire. Inert today (the reducer
  // spreads the widget rather than key-assigning its own keys), but an own
  // `__proto__`/`constructor`/`prototype` key was previously accepted and round-tripped;
  // rejecting it here keeps the create path (`addWidget`/`applyBulkUpdate.addedWidgets`)
  // symmetric with the update path and with the `config`-level screen just below. Uses
  // the SAME `hasUnsafeOwnKeys` predicate as every sibling check.
  if (hasUnsafeOwnKeys(widget)) {
    return `${path} must not carry a '__proto__'/'constructor'/'prototype' key`;
  }
  if (!isSafeId(widget.id)) {
    return `${path}.id must be a string id and not '__proto__'/'constructor'/'prototype'`;
  }
  if (!isString(widget.kind)) {
    return `${path}.kind must be a string`;
  }
  if (!isString(widget.title)) {
    return `${path}.title must be a string`;
  }
  if (!isOptionalString(widget.subtitle)) {
    return `${path}.subtitle must be a string when present`;
  }
  if (!isOptionalString(widget.sourceId)) {
    return `${path}.sourceId must be a string when present`;
  }
  // `titleMode`/`subtitleMode` mirror the `updateWidget.changes` checks: without
  // these, a junk value (e.g. `titleMode: 42`) passes the wire gate and persists
  // into a field the client's auto-title logic branches on.
  if (!isTitleModeValue(widget.titleMode)) {
    return `${path}.titleMode must be 'auto' or 'manual' when present`;
  }
  if (!isTitleModeValue(widget.subtitleMode)) {
    return `${path}.subtitleMode must be 'auto' or 'manual' when present`;
  }
  if (!isRecord(widget.config)) {
    return `${path}.config must be an object`;
  }
  // Mirrors every other config-carrying arg in this file (`updateWidget.config`,
  // `updateWidget.changes.config`, `applyBulkUpdate.updatedWidgets[].config`,
  // `applyBulkUpdate.widgetColSpans`): a full-widget `config` carrying an own
  // `__proto__`/`constructor`/`prototype` key is rejected here even for a custom
  // kind, where `validateConfigKeysForKind` would otherwise allow anything.
  if (hasUnsafeOwnKeys(widget.config)) {
    return `${path}.config must not carry a '__proto__'/'constructor'/'prototype' key`;
  }
  // Depth/breadth bound on the deliberately-uninterpreted `config` interior — see
  // `isBoundedValue`. Applied at every config-carrying channel in this file.
  if (!isBoundedValue(widget.config)) {
    return unboundedValueError(`${path}.config`);
  }
  // Fail-closed per-kind config-key check (matches this file's other validators,
  // which are all fail-closed on untrusted wire input): a widget carrying a
  // config key that belongs to a DIFFERENT widget kind (e.g. a Chart-only key on
  // a Grid widget) is rejected. Custom/unknown kinds are unrestricted (the
  // validator returns no invalid keys for them). This is the wire-boundary
  // counterpart to `StudioController.updateWidgetConfig`'s in-process guard; it
  // applies wherever a full widget with a known `kind` crosses the boundary
  // (`addWidget`, `applyBulkUpdate.addedWidgets`). Note: an `updateWidget`
  // mutation carries only a config PATCH with no `kind`, so it cannot be
  // kind-validated here — that path is covered in-process by the controller and,
  // for the AI tool boundary, by Stage 3's middleware validation.
  const invalidConfigKeys = validateConfigKeysForKind(widget.kind, widget.config);
  if (invalidConfigKeys.length > 0) {
    return `${path}.config carries key(s) not valid for a '${widget.kind}' widget: ${invalidConfigKeys.join(', ')}`;
  }
  // Membership-check an explicit `chartType` for chart widgets: it is fatal — there are no
  // custom chart types, and an unknown one wedges every later AI `update_widget` on the
  // widget (the middleware hard-errors on an unknown stored chartType). An ABSENT
  // `chartType` is legal and resolves to `'bar'` downstream (`resolveChartType`).
  //
  // Keys belonging to a DIFFERENT chart family (e.g. a gauge keeping a bar-era `xField`)
  // are deliberately left ALONE — see this function's doc comment for why. This validator
  // therefore never rewrites its input, so a config that crosses it keeps its object
  // identity and the reducer's reference-equality no-op contract is unaffected.
  if (widget.kind === 'chart') {
    const chartTypeValue = widget.config.chartType;
    if (
      chartTypeValue !== undefined &&
      (!isString(chartTypeValue) || !isStudioChartType(chartTypeValue))
    ) {
      return `${path}.config.chartType must be one of the known chart types`;
    }
  }
  // Bound the WHOLE widget record last (see `isBoundedValue`). The fields above are
  // shape-checked one by one, but unknown extra own keys are deliberately tolerated for
  // forward compatibility while the reducer installs the widget verbatim
  // (`widgets[widget.id] = widget`), so an unnamed key is the one place arbitrary payload
  // can still cross. Bounding the record subsumes the narrower `config` check above
  // (which runs first purely so a deep `config` still reports its own path) and cannot be
  // out-run by a future extra key.
  if (!isBoundedValue(widget)) {
    return unboundedValueError(path);
  }
  return null;
}

/**
 * Required string id fields per `StudioFilterScope` kind (see `stateTypes.ts`). The
 * `page` kind's `pageId` is optional, so it lists none here — `validateFilterScope`
 * separately type-checks it with `isOptionalString` when present, since an OPTIONAL id
 * field still needs to be a string when it IS supplied. An object literal, so its own
 * keys are exactly the five valid scope kinds — a `kind` of `'constructor'` fails the
 * `Object.hasOwn` check rather than resolving up the prototype chain.
 */
const FILTER_SCOPE_REQUIRED_IDS: Record<StudioFilterScope['kind'], readonly string[]> = {
  page: [],
  widget: ['widgetId'],
  'cross-filter': ['sourceWidgetId', 'pageId'],
  interactive: ['sourceWidgetId', 'pageId'],
  'dashboard-date-range': ['sourceId', 'pageId'],
};

function validateFilterScope(scope: unknown, path: string): string | null {
  if (!isRecord(scope)) {
    return `${path} must be an object`;
  }
  // Screen the scope object's OWN top-level keys for the prototype-hazard denylist
  // (Tier2 finding), closing the one nested record `validateFilter` didn't already cover:
  // every OTHER record embedded in a mutation payload (the filter itself, a widget, a
  // widget's config) is screened via `hasUnsafeOwnKeys` before being trusted, but `scope`
  // — a record nested one level inside `filter` — was never checked here, even though
  // `addFilter`'s reducer handler installs the filter (and therefore its `scope`) verbatim.
  // Reused by `isValidFilterScope` below, so the persistence load boundary
  // (`statePersistence.ts`, which screens every OTHER filter field for unsafe own keys)
  // inherits the same fix rather than drifting from this wire-boundary check. Uses the
  // SAME `hasUnsafeOwnKeys` predicate as every sibling check in this file.
  if (hasUnsafeOwnKeys(scope)) {
    return `${path} must not carry a '__proto__'/'constructor'/'prototype' key`;
  }
  const { kind } = scope;
  if (typeof kind !== 'string' || !Object.hasOwn(FILTER_SCOPE_REQUIRED_IDS, kind)) {
    return `${path}.kind must be one of ${Object.keys(FILTER_SCOPE_REQUIRED_IDS).join(', ')}`;
  }
  const requiredIds = FILTER_SCOPE_REQUIRED_IDS[kind as StudioFilterScope['kind']];
  for (const idField of requiredIds) {
    if (!isString(scope[idField])) {
      return `${path}.${idField} must be a string for scope kind '${kind}'`;
    }
  }
  // The `page` kind's `pageId` is OPTIONAL (a legacy pageId-less `page` scope applies
  // to every page), so it is absent from `FILTER_SCOPE_REQUIRED_IDS` and would
  // otherwise never be type-checked at all — the reducer's/load boundary's
  // `Object.hasOwn(state.pages, scope.pageId)` orphan checks coerce a numeric
  // `pageId` to match a string page key, so an unchecked numeric value would
  // install/round-trip verbatim instead of being rejected here.
  if (kind === 'page' && !isOptionalString(scope.pageId)) {
    return `${path}.pageId must be a string for scope kind 'page'`;
  }
  // Bound the WHOLE scope record (see `isBoundedValue`). Only `kind` and the id fields
  // this scope kind requires are named above; every other own key is tolerated for
  // forward compatibility and survives into the doc — the reducer appends the filter
  // (and therefore its scope) verbatim, and `stripUnsafeFilterKeys` removes only the
  // prototype-hazard names, not arbitrary extras. `isValidFilterScope` below delegates
  // here, so the persistence load boundary inherits the same bound.
  if (!isBoundedValue(scope)) {
    return unboundedValueError(path);
  }
  return null;
}

/**
 * Boolean predicate form of {@link validateFilterScope}: `true` when `scope` is a
 * structurally-valid `StudioFilterScope` — a record whose `kind` is one of the five known
 * kinds AND which carries every id field that kind requires (`widget` → `widgetId`,
 * `cross-filter`/`interactive` → `sourceWidgetId`+`pageId`, `dashboard-date-range` →
 * `sourceId`+`pageId`; `page` requires none, but its OPTIONAL `pageId` must still be a
 * string when present).
 *
 * Exported as the ONE shared scope-validity check so the persistence load boundary
 * (`statePersistence.ts`'s `deserializeState` filter screen and `findMissingRequiredField`)
 * agrees, byte-for-byte, with this wire boundary on which scopes are well-formed — a
 * scope missing a required id (e.g. a `dashboard-date-range` without `sourceId`, which
 * would otherwise mis-apply a date window) is now dropped/rejected on load exactly as the
 * identical wire payload is rejected here. Delegates to `validateFilterScope` so the two
 * forms can never drift.
 */
export function isValidFilterScope(scope: unknown): scope is StudioFilterScope {
  return validateFilterScope(scope, 'scope') === null;
}

/**
 * Shallow validation of a `StudioFilterState` embedded in `addFilter`. `id` must be a
 * safe id, `field` must be a string, `operator` (and a PRESENT `operator2`) must be a
 * member of the closed `StudioFilterOperator` union, and `scope` must be a valid scope;
 * the filter's `value` (and other condition/rank leaf payload) is left unchecked — the
 * reducer appends the filter verbatim and only keys off its `id`, so `value` is a leaf
 * the validator does not need to interpret.
 *
 * `field`/`operator` ARE read downstream (`mutationLabel` interpolates `filter.field`,
 * and the client pipeline / data middleware branch on both), so a junk value like
 * `field: 42` or `operator: {}` would install an active-but-unevaluable filter that
 * silently renders every widget in scope empty. Mirrors the `titleMode: 42`-class gaps
 * closed elsewhere in this file — check what other code keys/iterates on.
 *
 * `operator` gets a MEMBERSHIP check (not just `isString`), for the same reason
 * `chartType`/`scope.kind`/`titleMode` do: the client's evaluator branches on it and
 * FAILS OPEN on an unknown value (`filterUtils.ts` `default: return () => true;`), so a
 * plausible-but-wrong string like `'equal'` would install a filter chip that renders as
 * ACTIVE while filtering nothing — silently wrong displayed data, strictly worse than a
 * rejected mutation. The AI-tool boundary already membership-checks this exact value
 * (`invalidFilterOperatorError`), so a string-only check here left the two boundaries
 * disagreeing on an identical payload. Both now share the
 * one `isStudioFilterOperator` list. `operator2` is optional (absent stays legal), but
 * a PRESENT value carries the identical fail-open hazard for a compound filter's second
 * condition, so it is membership-checked the same way when present.
 *
 * The remaining closed-union leaf fields — `filterMode`, `conjunction`, `rankDirection`,
 * `dateRangePreset` — are deliberately left unchecked: unlike `operator`, the client's
 * evaluator DEGRADES SAFELY rather than fails open for each. A junk `filterMode` falls
 * through to condition mode, a junk `conjunction` behaves as `'and'`, a junk
 * `rankDirection` behaves as `'top'` (rank-mode default), and `dateRangePreset` is an
 * 11-member display-only annotation the evaluator never branches on. None can produce
 * the active-chip-that-filters-nothing failure, so the wire boundary tolerates them for
 * forward compatibility rather than rejecting a payload the evaluator handles safely.
 */
function validateFilter(filter: unknown, path: string): string | null {
  if (!isRecord(filter)) {
    return `${path} must be an object`;
  }
  // Screen the filter object's OWN top-level keys for the prototype-hazard denylist,
  // closing the parity gap with `validateWidget` (which already screens
  // its widget object's own keys). The reducer's `addFilter` appends the filter verbatim
  // (`[...state.filters, args.filter]`), so an own `__proto__`/`constructor`/`prototype`
  // key would round-trip through `serializeDoc` and poison a later `Object.assign`/spread
  // of the filter. Mirrored on load by `deserializeState`'s persisted-filter screen. Uses
  // the SAME `hasUnsafeOwnKeys` predicate as every sibling check.
  if (hasUnsafeOwnKeys(filter)) {
    return `${path} must not carry a '__proto__'/'constructor'/'prototype' key`;
  }
  if (!isSafeId(filter.id)) {
    return `${path}.id must be a string id and not '__proto__'/'constructor'/'prototype'`;
  }
  if (!isString(filter.field)) {
    return `${path}.field must be a string`;
  }
  if (!isStudioFilterOperator(filter.operator)) {
    return `${path}.operator must be one of ${STUDIO_FILTER_OPERATORS.join(', ')}`;
  }
  if (filter.operator2 !== undefined && !isStudioFilterOperator(filter.operator2)) {
    return `${path}.operator2 must be one of ${STUDIO_FILTER_OPERATORS.join(', ')} when present`;
  }
  // `dependsOn` (`StudioFilterState.dependsOn?: string[]` in `stateTypes.ts`) is a list of
  // OTHER filter ids this one cascades from. It was previously left entirely unchecked, so
  // any shape — a non-array, or an array with non-string elements — passed the wire gate.
  // The x-studio-side consumer (`docTransforms.ts`) does unguarded `.filter()`/`.map()` over
  // `dependsOn`, so a malformed value (e.g. `dependsOn: 'w1'` or `dependsOn: [1, 2]`) reaching
  // it would throw downstream; reject it here at the wire boundary instead, mirroring the
  // `isStringArray` check every other array-of-ids field in this file already gets
  // (`unsetFields`/`unsetConfigKeys`/`removedWidgetIds`/`rowWidgetIds`).
  if (filter.dependsOn !== undefined && !isStringArray(filter.dependsOn)) {
    return `${path}.dependsOn must be a string[] when present`;
  }
  // `value`/`value2` stay UNINTERPRETED (the reducer appends the filter verbatim and only
  // keys off its `id`), but they must still be BOUNDED — see `isBoundedValue`. Without
  // this, `addFilter` was the exact same `JSON.stringify`-blows-the-stack vector as an
  // unbounded widget `config`: a ~20 KB deeply-nested `value` installed into `doc.filters`
  // and then broke every subsequent autosave and every `structuredClone` in `migrateState`.
  if (!isBoundedValue(filter.value)) {
    return unboundedValueError(`${path}.value`);
  }
  if (!isBoundedValue(filter.value2)) {
    return unboundedValueError(`${path}.value2`);
  }
  const scopeError = validateFilterScope(filter.scope, `${path}.scope`);
  if (scopeError) {
    return scopeError;
  }
  // Bound the WHOLE filter record last (see `isBoundedValue`), for the same reason
  // `validateWidget` does: the fields above are named one by one, but unknown extra own
  // keys are tolerated for forward compatibility and `addFilter` appends the filter
  // verbatim (`[...state.filters, args.filter]`), so an unnamed key carries exactly the
  // payload the `value`/`value2` checks above are there to stop. Runs after the named
  // checks so a deep `value`/`value2`/`scope` still reports its own path; it subsumes
  // them.
  if (!isBoundedValue(filter)) {
    return unboundedValueError(path);
  }
  return null;
}

// ── Per-variant arg validators ──────────────────────────────────────────────────

/**
 * Exhaustive validator table over every `StateMutation` variant. The mapped type
 * `{ [M in StateMutation as M['type']]: ... }` is the SAME exhaustiveness trick
 * `MUTATION_HANDLERS` uses in `applyMutation.ts`: it forces one entry per mutation
 * kind, so a new `StateMutation` variant added without a matching validator entry
 * is a compile-time error here, not a silently-unvalidated gap at runtime.
 *
 * Each validator receives the already-confirmed-to-be-a-record `args` and returns
 * `null` when valid or a descriptive error naming the offending field. Only the
 * fields the reducer keys/iterates on are checked; leaf payloads (widget `config`,
 * filter `value`) stay shallow, and unknown EXTRA keys are tolerated for forward
 * compatibility (an older client receiving a newer server's additive field).
 *
 * Tolerated is not unbounded: every record the reducer installs VERBATIM (a widget, a
 * filter, a filter scope) is additionally checked as a whole by `isBoundedValue`, so an
 * unknown key can carry a new field but not an unbounded one.
 */
type MutationArgValidator = (args: Record<string, unknown>) => string | null;

const MUTATION_ARG_VALIDATORS: { [M in StateMutation as M['type']]: MutationArgValidator } = {
  addPage: (args) => {
    if (!isSafeId(args.id)) {
      return "addPage.args.id must be a string id and not '__proto__'/'constructor'/'prototype'";
    }
    if (!isString(args.title)) {
      return 'addPage.args.title must be a string';
    }
    return null;
  },

  setDashboardTitle: (args) =>
    isString(args.title) ? null : 'setDashboardTitle.args.title must be a string',

  addWidget: (args) => {
    const widgetError = validateWidget(args.widget, 'addWidget.args.widget');
    if (widgetError) {
      return widgetError;
    }
    if (!isOptionalString(args.pageId)) {
      return 'addWidget.args.pageId must be a string when present';
    }
    return null;
  },

  updateWidget: (args) => {
    if (!isSafeId(args.widgetId)) {
      return "updateWidget.args.widgetId must be a string id and not '__proto__'/'constructor'/'prototype'";
    }
    if (args.changes !== undefined) {
      if (!isRecord(args.changes)) {
        return 'updateWidget.args.changes must be an object when present';
      }
      if (hasUnsafeOwnKeys(args.changes)) {
        return "updateWidget.args.changes must not carry a '__proto__'/'constructor'/'prototype' key";
      }
      // `changes` is a wholesale widget merge, so its per-field types must be
      // checked (unlike the `config` patch, whose per-kind interior stays a leaf).
      // `id` is also the `state.widgets` map key: an own `id` in `changes` would
      // desync `widget.id` from its key (splitting every id-keyed invariant —
      // cross-filters, span lookups, layout rows), so it is rejected outright. The
      // compile-time `Partial<Omit<StudioWidget, 'id'>>` gets its runtime
      // counterpart here.
      if (Object.hasOwn(args.changes, 'id')) {
        return 'updateWidget.args.changes must not carry an id (it would desync the widget from its map key)';
      }
      // Every string-valued and title-mode-valued `StudioWidgetOf` field a wholesale
      // `changes` merge can carry, iterated from the COMPILE-LOCKED partitions in
      // `widgetTypeGuards.ts` rather than re-listed here. Without these checks a junk value
      // (e.g. `titleMode: 42`) passes the wire gate and persists into a field the client's
      // auto-title logic branches on; without the lock, a new widget field would silently
      // get no wire check at all. (`id` is rejected outright above, and `config` is handled
      // below — `WIDGET_OTHER_FIELDS` is exactly those two.)
      const changesRecord = args.changes as Record<string, unknown>;
      for (const field of WIDGET_STRING_FIELDS) {
        if (!isOptionalString(changesRecord[field])) {
          return `updateWidget.args.changes.${field} must be a string when present`;
        }
      }
      for (const field of WIDGET_TITLE_MODE_FIELDS) {
        if (!isTitleModeValue(changesRecord[field])) {
          return `updateWidget.args.changes.${field} must be 'auto' or 'manual' when present`;
        }
      }
      if (args.changes.config !== undefined) {
        if (!isRecord(args.changes.config)) {
          return 'updateWidget.args.changes.config must be an object when present';
        }
        if (hasUnsafeOwnKeys(args.changes.config)) {
          return "updateWidget.args.changes.config must not carry a '__proto__'/'constructor'/'prototype' key";
        }
        if (!isBoundedValue(args.changes.config)) {
          return unboundedValueError('updateWidget.args.changes.config');
        }
        // `config`'s interior is deliberately left as an unchecked
        // leaf (see the module doc), but `chartType` is the one leaf key every
        // OTHER config-carrying arg in this file already membership-checks on the
        // create path (`validateWidget`). Leaving it unchecked here let an
        // arbitrary/non-string `chartType` persist through a PATCH, silently
        // fall back to a default chart client-side, and then wedge every later
        // legitimate AI `update_widget` on that widget (the middleware hard-errors
        // on an unknown stored `chartType`).
        if (hasInvalidChartTypeInConfig(args.changes.config)) {
          return 'updateWidget.args.changes.config.chartType must be one of the known chart types when present';
        }
      }
    }
    if (args.config !== undefined) {
      if (!isRecord(args.config)) {
        return 'updateWidget.args.config must be an object when present';
      }
      if (hasUnsafeOwnKeys(args.config)) {
        return "updateWidget.args.config must not carry a '__proto__'/'constructor'/'prototype' key";
      }
      if (!isBoundedValue(args.config)) {
        return unboundedValueError('updateWidget.args.config');
      }
      // See the identical check on `changes.config` above.
      if (hasInvalidChartTypeInConfig(args.config)) {
        return 'updateWidget.args.config.chartType must be one of the known chart types when present';
      }
    }
    // The wire-safe field/config-key clear affordance. Both are arrays of KEY
    // NAMES (a `delete` target, never a `record[key] = value` set), so an entry
    // like `'__proto__'` is harmless — a plain `string[]` check is sufficient.
    if (args.unsetFields !== undefined && !isStringArray(args.unsetFields)) {
      return 'updateWidget.args.unsetFields must be a string[] when present';
    }
    if (args.unsetConfigKeys !== undefined && !isStringArray(args.unsetConfigKeys)) {
      return 'updateWidget.args.unsetConfigKeys must be a string[] when present';
    }
    return null;
  },

  removeWidget: (args) =>
    isSafeId(args.widgetId)
      ? null
      : "removeWidget.args.widgetId must be a string id and not '__proto__'/'constructor'/'prototype'",

  setWidgetLayout: (args) => {
    if (!isStringMatrix(args.rows)) {
      return 'setWidgetLayout.args.rows must be a string[][]';
    }
    if (!isOptionalString(args.pageId)) {
      return 'setWidgetLayout.args.pageId must be a string when present';
    }
    return null;
  },

  setWidgetColSpan: (args) => {
    if (!isSafeId(args.widgetId)) {
      return "setWidgetColSpan.args.widgetId must be a string id and not '__proto__'/'constructor'/'prototype'";
    }
    if (args.columns !== null && !isFiniteNumber(args.columns)) {
      return 'setWidgetColSpan.args.columns must be a finite number or null';
    }
    if (!isStringArray(args.rowWidgetIds)) {
      return 'setWidgetColSpan.args.rowWidgetIds must be a string[]';
    }
    // Per-entry safe-id check (mirrors `applyBulkUpdate.removedWidgetIds`): a
    // `rowWidgetIds` entry becomes the sibling-rebalance bracket-assignment target in
    // the reducer, so an unsafe id must be rejected at the wire boundary.
    for (const id of args.rowWidgetIds) {
      if (!isSafeId(id)) {
        return "setWidgetColSpan.args.rowWidgetIds entries must not be '__proto__'/'constructor'/'prototype'";
      }
    }
    if (!isOptionalString(args.pageId)) {
      return 'setWidgetColSpan.args.pageId must be a string when present';
    }
    return null;
  },

  renamePage: (args) => {
    if (!isSafeId(args.pageId)) {
      return "renamePage.args.pageId must be a string id and not '__proto__'/'constructor'/'prototype'";
    }
    if (!isString(args.title)) {
      return 'renamePage.args.title must be a string';
    }
    return null;
  },

  removePage: (args) =>
    isSafeId(args.pageId)
      ? null
      : "removePage.args.pageId must be a string id and not '__proto__'/'constructor'/'prototype'",

  setActivePage: (args) =>
    isSafeId(args.pageId)
      ? null
      : "setActivePage.args.pageId must be a string id and not '__proto__'/'constructor'/'prototype'",

  addFilter: (args) => validateFilter(args.filter, 'addFilter.args.filter'),

  removeFilter: (args) =>
    isString(args.filterId) ? null : 'removeFilter.args.filterId must be a string',

  applyBulkUpdate: (args) => {
    if (!isStringArray(args.removedWidgetIds)) {
      return 'applyBulkUpdate.args.removedWidgetIds must be a string[]';
    }
    for (const id of args.removedWidgetIds) {
      if (!isSafeId(id)) {
        return "applyBulkUpdate.args.removedWidgetIds entries must not be '__proto__'/'constructor'/'prototype'";
      }
    }
    if (!Array.isArray(args.addedWidgets)) {
      return 'applyBulkUpdate.args.addedWidgets must be an array';
    }
    // Tier2 finding: `addedWidgets`/`updatedWidgets` are validated by a per-entry
    // loop rather than one of the shared array predicates above, so they need their
    // own explicit length cap — otherwise a bulk update carrying an unbounded number
    // of widget entries passes every per-entry shape check individually.
    if (args.addedWidgets.length > MAX_ARRAY_LENGTH) {
      return `applyBulkUpdate.args.addedWidgets must not contain more than ${MAX_ARRAY_LENGTH} entries`;
    }
    for (let i = 0; i < args.addedWidgets.length; i += 1) {
      const widgetError = validateWidget(
        args.addedWidgets[i],
        `applyBulkUpdate.args.addedWidgets[${i}]`,
      );
      if (widgetError) {
        return widgetError;
      }
    }
    if (!Array.isArray(args.updatedWidgets)) {
      return 'applyBulkUpdate.args.updatedWidgets must be an array';
    }
    if (args.updatedWidgets.length > MAX_ARRAY_LENGTH) {
      return `applyBulkUpdate.args.updatedWidgets must not contain more than ${MAX_ARRAY_LENGTH} entries`;
    }
    for (let i = 0; i < args.updatedWidgets.length; i += 1) {
      const update = args.updatedWidgets[i];
      const at = `applyBulkUpdate.args.updatedWidgets[${i}]`;
      if (!isRecord(update)) {
        return `${at} must be an object`;
      }
      if (!isSafeId(update.widgetId)) {
        return `${at}.widgetId must be a string id and not '__proto__'/'constructor'/'prototype'`;
      }
      if (update.title !== undefined && !isString(update.title)) {
        return `${at}.title must be a string when present`;
      }
      if (update.sourceId !== undefined && !isString(update.sourceId)) {
        return `${at}.sourceId must be a string when present`;
      }
      if (update.config !== undefined) {
        if (!isRecord(update.config)) {
          return `${at}.config must be an object when present`;
        }
        if (hasUnsafeOwnKeys(update.config)) {
          return `${at}.config must not carry a '__proto__'/'constructor'/'prototype' key`;
        }
        if (!isBoundedValue(update.config)) {
          return unboundedValueError(`${at}.config`);
        }
        // See the identical check on `updateWidget.args.config` above.
        if (hasInvalidChartTypeInConfig(update.config)) {
          return `${at}.config.chartType must be one of the known chart types when present`;
        }
      }
    }
    // Parser half — `widgetRows`/`widgetColSpans` are OPTIONAL: a
    // bulk update carrying only `updatedWidgets` (no removals, additions, layout
    // op, or colSpans) must be able to omit both entirely. The reducer (fixed in
    // the same round) treats "both absent" as "skip layout replacement, don't
    // wipe" — so this validator must pass true absence through unchanged rather
    // than defaulting to `[]`/`{}`, which would look identical to "replace the
    // layout with nothing" and cause the reducer to wipe it. Presence is still
    // shape-checked exactly as before.
    if (args.widgetRows !== undefined && !isStringMatrix(args.widgetRows)) {
      return 'applyBulkUpdate.args.widgetRows must be a string[][] when present';
    }
    if (args.widgetColSpans !== undefined && !isFiniteNumberRecord(args.widgetColSpans)) {
      return 'applyBulkUpdate.args.widgetColSpans must be a Record<string, number> when present';
    }
    // The reducer rebuilds `widgetColSpans` key-by-key, so an unsafe own key here
    // (e.g. `JSON.parse('{"__proto__":6}')`) is rejected even though it passes the
    // finite-number-record shape check above.
    if (
      args.widgetColSpans !== undefined &&
      hasUnsafeOwnKeys(args.widgetColSpans as Record<string, unknown>)
    ) {
      return "applyBulkUpdate.args.widgetColSpans must not carry a '__proto__'/'constructor'/'prototype' key";
    }
    if (!isSafeId(args.activePageId)) {
      return "applyBulkUpdate.args.activePageId must be a string id and not '__proto__'/'constructor'/'prototype'";
    }
    return null;
  },

  renameAIThread: (args) => {
    if (!isString(args.name)) {
      return 'renameAIThread.args.name must be a string';
    }
    if (!isString(args.updatedAt)) {
      return 'renameAIThread.args.updatedAt must be a string';
    }
    if (!isOptionalString(args.threadId)) {
      return 'renameAIThread.args.threadId must be a string when present';
    }
    return null;
  },
};

/**
 * The mutation types `parseStateMutation` can validate, derived at runtime from the
 * validator table's own keys. Exported alongside `MUTATION_TYPES` (the reducer's
 * handler keys) purely so a table-sync test can assert the two sets are identical —
 * an observable pin backing the compile-time exhaustiveness guarantee.
 */
export const PARSEABLE_MUTATION_TYPES = Object.keys(
  MUTATION_ARG_VALIDATORS,
) as StateMutation['type'][];

/**
 * Validate an untrusted `value` claiming to be a `StateMutation`. It never clones: on
 * success it returns the SAME object (typed as `StateMutation`); on any failure it
 * returns a descriptive `error` string naming the field and why it was rejected (a
 * loggable reason where the reducer's dispatch would otherwise silently no-op).
 *
 * It is a pure gate: no validator rewrites its input. `validateWidget` used to be the one
 * exception, normalizing a full widget's chart `config` in place by stripping its
 * foreign-chart-family keys (via `stripForeignFamilyKeys`) — it no longer does (see
 * `validateWidget`'s own doc comment for why). Nothing here is rewritten.
 */
export function parseStateMutation(value: unknown): ParseStateMutationResult {
  if (!isRecord(value)) {
    return { ok: false, error: 'mutation must be a plain object' };
  }
  const { type } = value;
  if (typeof type !== 'string') {
    return { ok: false, error: 'mutation.type must be a string' };
  }
  // `Object.hasOwn` (never `type in ...`) so an untrusted `type` of `'constructor'`
  // or `'__proto__'` cannot resolve through the validator table's prototype chain.
  if (!Object.hasOwn(MUTATION_ARG_VALIDATORS, type)) {
    return { ok: false, error: `unknown mutation type '${type}'` };
  }
  if (!isRecord(value.args)) {
    return { ok: false, error: `mutation.args must be a plain object for type '${type}'` };
  }
  const validate = MUTATION_ARG_VALIDATORS[type as StateMutation['type']];
  const error = validate(value.args);
  if (error) {
    return { ok: false, error };
  }
  return { ok: true, mutation: value as StateMutation };
}
