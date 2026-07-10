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
import { validateChartConfigKeysForType, validateConfigKeysForKind } from './configKeyValidation';
import { isStudioChartType } from './widgetTypeGuards';
import { UNSAFE_KEYS, isSafeKey } from './unsafeKeys';

export type ParseStateMutationResult =
  | { ok: true; mutation: StateMutation }
  | { ok: false; error: string };

// ── Shared leaf predicates ──────────────────────────────────────────────────────

/** A plain object (not `null`, not an array). Everything the wire carries as an
 *  `args` bag, a widget, a filter, or a scope must satisfy this. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/** Absent (`undefined`) is fine; if present it must be a string. Used for every
 *  optional string field so a missing optional field never rejects a valid payload. */
function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/** Absent, or one of the `'auto' | 'manual'` literals. Used for `titleMode`/
 *  `subtitleMode` in `updateWidget.changes`: a stricter check than `isOptionalString`
 *  so a junk value (e.g. `titleMode: 42`, or an arbitrary string) can't persist into a
 *  field the client's auto-title logic branches on. */
function isOptionalTitleMode(value: unknown): value is 'auto' | 'manual' | undefined {
  return value === undefined || value === 'auto' || value === 'manual';
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
  return typeof value === 'string' && isSafeKey(value);
}

/** A real `string[]` — `Array.isArray` first, so the string `"abc"` (which is
 *  iterable char-by-char) can never masquerade as `['a','b','c']`. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

/** A `string[][]` (used by `setWidgetLayout.rows`/`applyBulkUpdate.widgetRows`).
 *  Every element must itself be a real `string[]`, so a mixed-depth value such as
 *  `[['a'], 'b']` is rejected rather than the `'b'` slipping through. */
function isStringMatrix(value: unknown): value is string[][] {
  return Array.isArray(value) && value.every((row) => isStringArray(row));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A `Record<string, number>` with every value a finite number
 *  (used by `applyBulkUpdate.widgetColSpans`). */
function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((v) => isFiniteNumber(v));
}

/**
 * True when `record` carries one of the prototype-polluting keys as an OWN property.
 * The reducer rebuilds `updateWidget.config`/`changes` and `applyBulkUpdate`'s
 * `widgetColSpans` key-by-key, so a payload carrying `__proto__` as a real own key
 * (e.g. `JSON.parse('{"__proto__":…}')`, where it IS an own property rather than the
 * prototype accessor) is rejected here at the wire boundary. The reducer's own
 * `isSafePatchKey` guard is the defense-in-depth backstop for server-built mutations.
 */
function hasUnsafeOwnKeys(record: Record<string, unknown>): boolean {
  return Object.keys(record).some((key) => UNSAFE_KEYS.has(key));
}

/**
 * True when `config` carries an own `chartType` key whose value is present
 * (not `undefined`) but is not a member of the closed `StudioChartType` union —
 * e.g. `chartType: 'trendline'` or a non-string like `chartType: 42`.
 *
 * Finding 2.2 — the full-widget create path (`validateWidget`, used by
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
 */
function hasInvalidChartTypeInConfig(config: Record<string, unknown>): boolean {
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
 * CONSTRAINT — full-widget variants may only carry FRESHLY-BUILT configs. The
 * chart-family check below is STATELESS (it resolves the family from the incoming
 * config's own `chartType`, with no access to any stored widget). A round-tripped
 * STORED chart config legitimately retains keys authored under a previously-selected
 * chartType (retention-across-chartType-switch — see `StudioChartConfig`'s doc in
 * `widgetTypes.ts`), so it would be rejected here for carrying another family's key
 * (e.g. a gauge keeping a bar-era `xField`). Today no producer round-trips a stored
 * widget through `addWidget`/`applyBulkUpdate.addedWidgets` (both middleware paths
 * build widgets fresh), so nothing breaks. A future producer that DOES ship a stored
 * widget verbatim must first strip its config to its effective family's keys via
 * `stripForeignFamilyKeys` (`configKeyValidation.ts`), or the valid, user-authored
 * config will fail this check.
 */
function validateWidget(widget: unknown, path: string): string | null {
  if (!isRecord(widget)) {
    return `${path} must be an object`;
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
  if (!isOptionalTitleMode(widget.titleMode)) {
    return `${path}.titleMode must be 'auto' or 'manual' when present`;
  }
  if (!isOptionalTitleMode(widget.subtitleMode)) {
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
  // Second, finer-grained fail-closed check for chart widgets: a chart config
  // carrying a key that belongs to a DIFFERENT chart family (e.g. `sankeyTargetField`
  // on a `gauge` chart) is rejected. An explicit `chartType` that is not a real
  // `StudioChartType` is itself rejected first — there are no custom chart types.
  //
  // Finding 2.3 — this validator only ever sees FULL-WIDGET creation payloads
  // (`addWidget`/`applyBulkUpdate.addedWidgets`; see the STATELESS constraint
  // above), so there is no "existing widget" to omit a discriminant relative to
  // in the first place: a fresh config with no `chartType` IS effectively a bar
  // chart, by the same `?? 'bar'` rule `resolveChartType`/the middleware's
  // `invalidChartConfigKeyError` apply (an empty config is a valid bar config).
  // Previously this check was skipped entirely whenever `chartType` was absent,
  // which meant `{ sankeyTargetField: 'x' }` with no `chartType` passed the wire
  // gate while the semantically identical `{ chartType: 'bar', sankeyTargetField:
  // 'x' }` was rejected — the middleware's own `buildWidgetFromArgs` already
  // resolves the same `'bar'` fallback and rejects it, so the two boundaries
  // disagreed on an identical payload. Using the same fallback here keeps them in
  // agreement. (An `updateWidget` config PATCH is a different case: it genuinely
  // has no full widget/kind to fall back from, so it is intentionally NOT
  // family-key-validated here — see `hasInvalidChartTypeInConfig`'s membership-only
  // check for that channel instead.)
  if (widget.kind === 'chart') {
    const chartTypeValue = widget.config.chartType;
    if (
      chartTypeValue !== undefined &&
      (!isString(chartTypeValue) || !isStudioChartType(chartTypeValue))
    ) {
      return `${path}.config.chartType must be one of the known chart types`;
    }
    const effectiveChartType = chartTypeValue === undefined ? 'bar' : chartTypeValue;
    const invalidChartKeys = validateChartConfigKeysForType(effectiveChartType, widget.config);
    if (invalidChartKeys.length > 0) {
      return `${path}.config carries key(s) not valid for a '${effectiveChartType}' chart: ${invalidChartKeys.join(', ')}`;
    }
  }
  return null;
}

/**
 * Required string id fields per `StudioFilterScope` kind (see `stateTypes.ts`). The
 * `page` kind's `pageId` is optional, so it lists none. An object literal, so its
 * own keys are exactly the five valid scope kinds — a `kind` of `'constructor'`
 * fails the `Object.hasOwn` check rather than resolving up the prototype chain.
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
  return null;
}

/**
 * Shallow validation of a `StudioFilterState` embedded in `addFilter`. `id` must be a
 * safe id, `field`/`operator` must be strings, and `scope` must be a valid scope; the
 * filter's `value` (and other condition/rank leaf payload) is left unchecked — the
 * reducer appends the filter verbatim and only keys off its `id`, so `value` is a leaf
 * the validator does not need to interpret.
 *
 * `field`/`operator` ARE read downstream (`mutationLabel` interpolates `filter.field`,
 * and the client pipeline / data middleware branch on both), so a junk value like
 * `field: 42` or `operator: {}` would install an active-but-unevaluable filter that
 * silently renders every widget in scope empty. Mirrors the `titleMode: 42`-class gaps
 * closed elsewhere in this file — check what other code keys/iterates on.
 */
function validateFilter(filter: unknown, path: string): string | null {
  if (!isRecord(filter)) {
    return `${path} must be an object`;
  }
  if (!isSafeId(filter.id)) {
    return `${path}.id must be a string id and not '__proto__'/'constructor'/'prototype'`;
  }
  if (!isString(filter.field)) {
    return `${path}.field must be a string`;
  }
  if (!isString(filter.operator)) {
    return `${path}.operator must be a string`;
  }
  return validateFilterScope(filter.scope, `${path}.scope`);
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
      if (!isOptionalString(args.changes.title)) {
        return 'updateWidget.args.changes.title must be a string when present';
      }
      if (!isOptionalString(args.changes.subtitle)) {
        return 'updateWidget.args.changes.subtitle must be a string when present';
      }
      if (!isOptionalString(args.changes.sourceId)) {
        return 'updateWidget.args.changes.sourceId must be a string when present';
      }
      if (!isOptionalString(args.changes.kind)) {
        return 'updateWidget.args.changes.kind must be a string when present';
      }
      // `titleMode`/`subtitleMode` are the only other `StudioWidget` fields a wholesale
      // `changes` merge can carry; without these checks a junk value (e.g.
      // `titleMode: 42`) passes the wire gate and persists into a field the client's
      // auto-title logic branches on.
      if (!isOptionalTitleMode(args.changes.titleMode)) {
        return "updateWidget.args.changes.titleMode must be 'auto' or 'manual' when present";
      }
      if (!isOptionalTitleMode(args.changes.subtitleMode)) {
        return "updateWidget.args.changes.subtitleMode must be 'auto' or 'manual' when present";
      }
      if (args.changes.config !== undefined) {
        if (!isRecord(args.changes.config)) {
          return 'updateWidget.args.changes.config must be an object when present';
        }
        if (hasUnsafeOwnKeys(args.changes.config)) {
          return "updateWidget.args.changes.config must not carry a '__proto__'/'constructor'/'prototype' key";
        }
        // Finding 2.2 — `config`'s interior is deliberately left as an unchecked
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
      // Finding 2.2 — see the identical check on `changes.config` above.
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
        // Finding 2.2 — see the identical check on `updateWidget.args.config` above.
        if (hasInvalidChartTypeInConfig(update.config)) {
          return `${at}.config.chartType must be one of the known chart types when present`;
        }
      }
    }
    // Finding T2-4 (parser half) — `widgetRows`/`widgetColSpans` are OPTIONAL: a
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
 * Validate an untrusted `value` claiming to be a `StateMutation`. A pure gate: it
 * neither clones nor normalizes — on success it returns the input unchanged (typed
 * as `StateMutation`); on any failure it returns a descriptive `error` string
 * naming the field and why it was rejected (a loggable reason where the reducer's
 * dispatch would otherwise silently no-op).
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
