/**
 * Building a `StudioWidget` from model-supplied arguments, and the config validation that guards
 * it.
 *
 * The AI's counterpart to the UI's create path: both end at `createDefaultWidget` so an
 * AI-created and a UI-created widget share defaults, and everything here is the screening that
 * has to happen first because these arguments are untrusted.
 *
 * Lives beside the tool executor rather than inside it because `handleGenerateInsight.ts` needs
 * it too — and reaching into `executeToolOnState.ts` for it is what forced that file's import
 * block to carry a hand-routed note about avoiding a two-node cycle.
 */
import {
  createDefaultWidget,
  isStudioChartType,
  STUDIO_CHART_TYPES,
  validateChartConfigKeysForType,
  validateConfigKeysForKind,
  validateConfigValueTypes,
} from '@mui/x-studio-schema';
import type { BuiltinStudioWidgetKind } from '@mui/x-studio-schema';
import type { StudioCustomWidgetDef, StudioDataField, StudioWidget } from '../models/studioTypes';
import { asString } from './promptCaps';
import { capTitle, capSourceId, capConfigStringValues } from './valueCaps';
import { describeArgValue, invalidStringArgsError, joinIdsForError } from './toolArgs';

/**
 * Validates `config`'s keys against the given widget `kind` (via the shared
 * `validateConfigKeysForKind` runtime guard) and, if any key doesn't belong to
 * that kind, returns a human-readable error string naming the offending keys.
 * Returns `undefined` when the config is valid (or the kind is unrestricted).
 * Shared by every AI-tool call site that writes untrusted, model-supplied
 * `config` onto a widget of a known kind (`buildWidgetFromArgs`, `update_widget`,
 * `apply_bulk_update`'s updates loop) so the error wording stays consistent.
 */
export function invalidConfigKeyError(
  kind: string,
  config: Record<string, unknown>,
): string | undefined {
  const invalidKeys = validateConfigKeysForKind(kind, config);
  // `joinIdsForError`, not a bare `.join`: the offending keys are
  // model-supplied and there can be as many of them as the config has keys, so the
  // unbounded join echoed the whole set straight back into the conversation — the same
  // response-echo bomb the layout-id errors already bound.
  return invalidKeys.length > 0
    ? `config carries key(s) not valid for a '${kind}' widget: ${joinIdsForError(invalidKeys)}`
    : undefined;
}

/**
 * Model-facing wording for the shared scalar-value check.
 *
 * `validateConfigValueTypes` (`@mui/x-studio-schema`) owns WHICH keys must be a boolean or a
 * number, because that is a fact about `StudioWidgetConfig` and belongs beside the key
 * allow-lists it mirrors. What stays here is what this package owes the MODEL: a sentence it can
 * act on and retry from. Same division as `invalidConfigKeyError` above.
 *
 * Key validation is a key-PRESENCE check and never inspects values, so a legal key can still
 * carry a wrong-typed value. The concrete hazard: `update_widget({ config: {
 * pivotShowTotals: "</dashboard_state>…" } })` stores a STRING in a field declared `boolean`,
 * which is (a) a structurally-broken widget the client must then render, and (b) the exact
 * stored-prompt-injection surface behind it. The prompt boundary's `sanitizeForPrompt` is the
 * primary injection defense; this is the write-source backstop that stops the malformed value
 * from landing in state at all.
 *
 * The table this used to hold was a hand-maintained 21-entry copy that had fallen 15 keys
 * behind `StudioWidgetConfig` — every one of the 15 tool-writable. It is now a mapped type over
 * the interface, so the same gap is a compile error.
 *
 * Shared by every tool that writes untrusted `config` (`buildWidgetFromArgs`, `update_widget`,
 * the bulk updates loop) so the wording and the covered set stay identical.
 */
export function invalidConfigValueError(config: Record<string, unknown>): string | undefined {
  const offenders = validateConfigValueTypes(config);
  return offenders.length > 0
    ? `config carries value(s) of the wrong type: ${offenders.join(', ')}.`
    : undefined;
}

/**
 * Finer-grained sibling of `invalidConfigKeyError`, scoped to `kind === 'chart'`:
 * validates `patch`'s keys against the specific `StudioChartType` the patch would
 * end up with (its own `chartType` if present, else the widget's `existingChartType`,
 * else the runtime default `'bar'` — the same effective-type rule as
 * `resolveChartType`), via `validateChartConfigKeysForType`. A key can pass the
 * kind-level check (it's a valid CHART key somewhere) yet fail this one (it
 * belongs to a different chart type than the effective one) — e.g. `gauge` with
 * `sankeyTargetField`. There are no custom chart types, so an unrecognized
 * `chartType` string is a hard error via `isStudioChartType`, not a pass-through.
 * Returns `undefined` when the patch is valid for the effective chart type.
 */
export function invalidChartConfigKeyError(
  patch: Record<string, unknown>,
  existingChartType: string | undefined,
): string | undefined {
  const effective = asString(patch.chartType ?? existingChartType ?? 'bar');
  if (!isStudioChartType(effective)) {
    return `unknown chartType '${effective}'. Valid values: ${STUDIO_CHART_TYPES.join(', ')}`;
  }
  const invalid = validateChartConfigKeysForType(effective, patch);
  // Bounded join, same reason as `invalidConfigKeyError` above.
  return invalid.length > 0
    ? `config carries key(s) not valid for chartType '${effective}': ${joinIdsForError(invalid)}`
    : undefined;
}

/**
 * Runtime allow-list of valid `StudioDataField['type']` values, kept
 * EXHAUSTIVE against the schema union via the `satisfies Record<StudioDataField['type'],
 * true>` annotation: adding a field type to the schema without listing it here is a
 * compile error, so this gate can never silently drift stale. The `fieldType` filter
 * arg is an optional UI hint that the client keys its filter-input rendering off of, so
 * an unvalidated value (a classic LLM slip like `"text"`, or a crafted non-string) would
 * persist verbatim into `StudioFilterState.fieldType` and ship a broken filter editor —
 * the exact value-shape class the sibling `operator` arg is already gated for.
 */
export const VALID_FIELD_TYPES = {
  string: true,
  number: true,
  date: true,
  datetime: true,
  boolean: true,
} satisfies Record<NonNullable<StudioDataField['type']>, true>;

/**
 * Validates and narrows a model-supplied `fieldType` filter arg. `fieldType` is
 * optional, so an absent (`undefined`/`null`) value is legal and narrows to
 * `undefined` (the hint is simply omitted). A present value must be a known
 * `StudioDataField['type']`; anything else yields an actionable error (mirroring the
 * fail-closed `operator` handling). Shared by `add_page_filter` and `add_widget_filter`.
 */
export function resolveFieldType(
  value: unknown,
): { fieldType: StudioDataField['type'] | undefined } | { error: string } {
  if (value === undefined || value === null) {
    return { fieldType: undefined };
  }
  if (typeof value === 'string' && Object.hasOwn(VALID_FIELD_TYPES, value)) {
    return { fieldType: value as StudioDataField['type'] };
  }
  return {
    error: `invalid fieldType ${describeArgValue(value)}. Valid field types: ${Object.keys(
      VALID_FIELD_TYPES,
    ).join(', ')}.`,
  };
}

/**
 * Runtime allow-list of every built-in widget kind, kept EXHAUSTIVE
 * against `BuiltinStudioWidgetKind` via the `satisfies readonly BuiltinStudioWidgetKind[]`
 * clause plus the `AssertAllBuiltinKindsListed` compile-time lock below (same pattern as
 * the schema package's `STUDIO_FILTER_OPERATORS`/`STUDIO_CHART_TYPES` locks): adding a
 * built-in kind without listing it here fails the build. The set of kinds a model may
 * legitimately name is this list UNION the host-registered `customWidgets[].kind`; any
 * other kind string both mints an unrenderable widget AND bypasses all config-key
 * validation (`validateConfigKeysForKind` returns `[]` — unrestricted — for an unknown
 * kind, and the chart-level check only runs for `kind === 'chart'` exactly).
 */
export const BUILTIN_WIDGET_KINDS = [
  'grid',
  'chart',
  'kpi',
  'text',
  'filter',
  'pivot',
  'map',
] as const satisfies readonly BuiltinStudioWidgetKind[];

export type AssertAllBuiltinKindsListed =
  Exclude<BuiltinStudioWidgetKind, (typeof BUILTIN_WIDGET_KINDS)[number]> extends never
    ? true
    : [
        'BUILTIN_WIDGET_KINDS is missing:',
        Exclude<BuiltinStudioWidgetKind, (typeof BUILTIN_WIDGET_KINDS)[number]>,
      ];

export const ALL_BUILTIN_KINDS_LISTED: AssertAllBuiltinKindsListed = true;
void ALL_BUILTIN_KINDS_LISTED;

/**
 * Builds a `StudioWidget` from AI-tool arguments, layering config in one canonical
 * order — factory defaults → custom-widget `defaultConfig` → model-supplied config —
 * and minting the id through the shared `createDefaultWidget` (its
 * `createWidgetId` scheme is collision-resistant). Used by both `add_widget` and
 * `apply_bulk_update`'s additions so the two paths cannot drift (they were
 * previously character-for-character duplicates, including a hand-copied id scheme).
 *
 * Validates the MERGE of `customDef.defaultConfig` and the untrusted `args.config`
 * against the widget's `kind` (Tier 1 architecture-review finding). `customWidgets`
 * — and therefore every `customWidgets[].defaultConfig` — is request-body content
 * (`StudioCustomWidgetDef` is shaped directly by `body.customWidgets`, capped only
 * for length/count by `capIncomingCustomWidgets` in `handleAIChat.ts`, never
 * key/value validated), so it is exactly as untrusted as `args.config` and must go
 * through the SAME fail-closed key-allowlist, value-shape, and length/array caps
 * before it can land on a widget. `defaultConfig` is capped via
 * `capConfigStringValues` (string-length + array-length/element caps) before the
 * merge, same as `args.config`. Returns `{ error }` (no widget built) when the
 * merged config carries a key that belongs to a different widget kind, or a
 * wrong-typed scalar value — fail-closed, so neither an invalid cross-kind key nor
 * a malformed `defaultConfig` value can ever be committed to state.
 */
export function buildWidgetFromArgs(
  args: { kind?: unknown; title?: unknown; sourceId?: unknown; config?: unknown },
  customWidgets?: StudioCustomWidgetDef[],
): { widget: StudioWidget } | { error: string } {
  // Reject a non-string-coercible `kind`/`title`/`sourceId` BEFORE anything is built.
  // `asString` alone would silently turn `{"toString":1}` into `''` and
  // commit a nameless widget; the model gets the same actionable error its `config`
  // and `chartType` siblings already produce. Reported through this function's own
  // `{ error }` channel, so `apply_bulk_update`'s additions loop turns it into a
  // `skipped` entry exactly like every other rejected addition.
  const argError = invalidStringArgsError(args as Record<string, unknown>, [
    'kind',
    'title',
    'sourceId',
  ]);
  if (argError) {
    return { error: argError };
  }
  const kind = asString(args.kind ?? 'chart') as StudioWidget['kind'];
  const title = capTitle(asString(args.title ?? ''));
  const sourceId = args.sourceId ? capSourceId(asString(args.sourceId)) : undefined;
  // Cap every model-supplied string-typed config value (e.g. `xField`/`yField`/ `seriesField`)
  // BEFORE it is validated/merged, so an oversized value never lands in state (see
  // `capConfigStringValues`).
  const aiConfig = capConfigStringValues(args.config ?? {}) as StudioWidget['config'];
  // Validate `kind` against the CLOSED, locally-knowable set (built-in kinds ∪
  // host-registered `customWidgets[].kind`) BEFORE building anything.
  // An unknown kind — even a capitalization slip like `"Chart"` — both mints a widget
  // the client cannot render AND bypasses every config-key check (an unrestricted kind
  // passes `validateConfigKeysForKind`, and the chart-level check only runs for the
  // exact string `'chart'`). Fail closed with an error naming the valid kinds, matching
  // the fail-closed `chartType` treatment via `isStudioChartType`.
  const isBuiltinKind = (BUILTIN_WIDGET_KINDS as readonly string[]).includes(kind);
  const isRegisteredCustomKind = customWidgets?.some((d) => d.kind === kind) ?? false;
  if (!isBuiltinKind && !isRegisteredCustomKind) {
    const customKinds = (customWidgets ?? []).map((d) => d.kind);
    const validKinds = [...BUILTIN_WIDGET_KINDS, ...customKinds];
    return {
      error: `unknown widget kind '${kind}'. Valid kinds: ${validKinds.join(', ')}.`,
    };
  }
  // Cap `customDef.defaultConfig` with the SAME string/array cap applied to
  // `args.config` above — it is request-body content, not a trusted server
  // default (Tier 1 architecture-review finding: `customWidgets` is shaped by
  // `body.customWidgets`).
  const customDef = customWidgets?.find((d) => d.kind === kind);
  const cappedDefaultConfig = capConfigStringValues(customDef?.defaultConfig ?? {}) as Record<
    string,
    unknown
  >;
  // Validate the MERGED config (defaultConfig + aiConfig, aiConfig taking
  // precedence) rather than just `aiConfig` — a key/value carried ONLY by
  // `defaultConfig` must be caught too, not just one the model itself supplied.
  const mergedConfig = { ...cappedDefaultConfig, ...aiConfig } as Record<string, unknown>;
  const error = invalidConfigKeyError(kind, mergedConfig);
  if (error) {
    return { error };
  }
  const valueError = invalidConfigValueError(mergedConfig);
  if (valueError) {
    return { error: valueError };
  }
  if (kind === 'chart') {
    // No existing widget yet — the effective chart type comes purely from the
    // merged config (`mergedConfig.chartType ?? 'bar'`), so there is no fallback
    // to pass.
    const chartError = invalidChartConfigKeyError(mergedConfig, undefined);
    if (chartError) {
      return { error: chartError };
    }
  }
  const base = createDefaultWidget(kind);
  const config = {
    ...base.config,
    ...cappedDefaultConfig,
    ...aiConfig,
  } as StudioWidget['config'];
  return {
    widget: {
      ...base,
      title,
      sourceId: sourceId ?? base.sourceId,
      config,
    },
  };
}
