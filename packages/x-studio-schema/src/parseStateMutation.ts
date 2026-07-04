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
  return (
    typeof value === 'string' &&
    value !== '__proto__' &&
    value !== 'constructor' &&
    value !== 'prototype'
  );
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

// ── Nested-structure validators ─────────────────────────────────────────────────

/**
 * Shallow validation of a `StudioWidget` embedded in `addWidget`/`applyBulkUpdate`.
 * `id` must be a safe id (it becomes a `Record` key), `kind`/`title` must be
 * strings, and `config` must be a plain object — but the config's per-kind interior
 * is deliberately NOT deep-validated: its many per-kind shapes are a leaf payload
 * the reducer never keys/iterates on, and deep-validating them here would drift on
 * every widget-config change for no safety gain.
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
  if (!isRecord(widget.config)) {
    return `${path}.config must be an object`;
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
 * Shallow validation of a `StudioFilterState` embedded in `addFilter`. `id` must be
 * a safe id and `scope` must be a valid scope; the filter's `value` (and other
 * condition/rank leaf payload) is left unchecked — the reducer appends the filter
 * verbatim and only keys off its `id`, so `value` is a leaf the validator does not
 * need to interpret.
 */
function validateFilter(filter: unknown, path: string): string | null {
  if (!isRecord(filter)) {
    return `${path} must be an object`;
  }
  if (!isSafeId(filter.id)) {
    return `${path}.id must be a string id and not '__proto__'/'constructor'/'prototype'`;
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
    if (args.changes !== undefined && !isRecord(args.changes)) {
      return 'updateWidget.args.changes must be an object when present';
    }
    if (args.config !== undefined && !isRecord(args.config)) {
      return 'updateWidget.args.config must be an object when present';
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
      if (update.config !== undefined && !isRecord(update.config)) {
        return `${at}.config must be an object when present`;
      }
    }
    if (!isStringMatrix(args.widgetRows)) {
      return 'applyBulkUpdate.args.widgetRows must be a string[][]';
    }
    if (!isFiniteNumberRecord(args.widgetColSpans)) {
      return 'applyBulkUpdate.args.widgetColSpans must be a Record<string, number>';
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
