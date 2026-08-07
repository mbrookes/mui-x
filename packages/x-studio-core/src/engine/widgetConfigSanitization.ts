import {
  validateConfigKeysForKind,
  validateChartConfigKeysForType,
  isStudioChartType,
  resolveChartType,
} from '@mui/x-studio-schema';
import type { StudioChartType, StudioWidgetKind, StudioWidget, StudioDataSource } from '../models';
import { inferWidgetTitles } from './widgetUtils';

/**
 * Returns a copy of `record` with every key in `invalidKeys` removed, preserving
 * the original key order of the survivors. Returns `record` UNCHANGED (same
 * reference) when `invalidKeys` is empty, so a no-op strip allocates nothing —
 * matching the identity-preservation convention the rest of the write-side config
 * guards rely on.
 *
 * The tiny shared primitive behind every "drop the keys the validators flagged"
 * step in {@link sanitizeWidgetConfigForChartType} and its `StudioController`
 * callers, which used to each hand-roll the same `Object.entries(...).filter(...)`
 * loop.
 */
export function stripKeys(
  record: Record<string, unknown>,
  invalidKeys: readonly string[],
): Record<string, unknown> {
  if (invalidKeys.length === 0) {
    return record;
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!invalidKeys.includes(key)) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Resolves the effective `StudioChartType` for a chart config's `chartType`
 * value: the value itself when it is a real, validated `StudioChartType`;
 * `fallback` when it is absent OR present-but-invalid.
 *
 * `wasInvalidExplicit` is `true` only for the latter case — an OWN,
 * non-undefined value that failed validation — so callers can distinguish "no
 * chartType supplied" (ordinary, never warned about) from "a bogus chartType
 * was dropped" (worth a dev warning) without re-deriving the check themselves.
 */
export function resolveEffectiveChartType(
  rawChartType: unknown,
  fallback: StudioChartType,
): { chartType: StudioChartType; wasInvalidExplicit: boolean } {
  if (typeof rawChartType === 'string' && isStudioChartType(rawChartType)) {
    return { chartType: rawChartType, wasInvalidExplicit: false };
  }
  return { chartType: fallback, wasInvalidExplicit: rawChartType !== undefined };
}

/**
 * Shared two-layer widget-config guard: strips config keys invalid for the
 * widget's `kind` (e.g. a Chart-only key returned/patched onto a Grid widget),
 * then — for a `'chart'` kind — strips keys invalid for the EFFECTIVE chart type
 * (see {@link resolveEffectiveChartType}).
 *
 * An explicit-but-invalid `chartType` is silently dropped from the returned
 * config before the chart-key layer runs, so a hostile/malformed type (e.g. an
 * LLM hallucination) fails closed to the fallback family rather than to an
 * empty allow-list that would strip every key.
 *
 * `chartTypeFallback` is a caller-supplied parameter rather than a hardcoded
 * constant because "what to fall back to" is caller-specific: a freshly
 * AI-created widget with no prior chart type falls back to the factory default
 * (`'bar'`, see `createWidgetFromDescription.ts`), while a repair of an
 * EXISTING widget could reasonably fall back to that widget's own currently
 * stored chart type instead (see `StudioController.sanitizeWidgetConfigForKind`,
 * which composes {@link resolveEffectiveChartType} and {@link stripKeys}
 * directly rather than calling this function, so it can also emit its own
 * dev warnings naming exactly what was dropped and why).
 */
export function sanitizeWidgetConfigForChartType(
  kind: StudioWidgetKind,
  rawConfig: Record<string, unknown>,
  chartTypeFallback: StudioChartType,
): Record<string, unknown> {
  const invalidKindKeys = validateConfigKeysForKind(kind, rawConfig);
  let config = stripKeys(rawConfig, invalidKindKeys);

  if (kind !== 'chart') {
    return config;
  }

  const { chartType, wasInvalidExplicit } = resolveEffectiveChartType(
    config.chartType,
    chartTypeFallback,
  );
  if (wasInvalidExplicit) {
    // Drop the bogus chartType so the caller's merged widget keeps a valid type
    // (its factory default, or — for a caller that merges onto an existing
    // widget — the pre-existing stored chartType, since a merge-patch that
    // omits `chartType` entirely leaves the stored value untouched).
    config = stripKeys(config, ['chartType']);
  }

  const invalidChartKeys = validateChartConfigKeysForType(chartType, config);
  return stripKeys(config, invalidChartKeys);
}

/* ─── Authoring-time widget sanitization ──────────────────────────────────────────────────
 *
 * Lifted out of `StudioController`, where they were private members that never touched the
 * store — pure `widget -> widget` / `config -> config` functions living in a class only because
 * that is where their callers happened to be. They belong next to the chart-type sanitizers
 * above, which they compose.
 */

export function applyInferredTitles(
  widget: StudioWidget,
  dataSources: Record<string, StudioDataSource>,
): StudioWidget {
  const inferred = inferWidgetTitles(widget, dataSources);
  const isAutoTitle = widget.titleMode === 'auto' || (!widget.titleMode && !widget.title);
  const isAutoSubtitle =
    widget.subtitleMode === 'auto' || (!widget.subtitleMode && !widget.subtitle);

  const title = isAutoTitle ? inferred.title : widget.title;
  const titleMode = isAutoTitle ? 'auto' : widget.titleMode;
  const subtitle = isAutoSubtitle ? inferred.subtitle : widget.subtitle;
  const subtitleMode = isAutoSubtitle ? 'auto' : widget.subtitleMode;

  // Reference-stable when nothing user-visible actually changed, so a caller
  // relying on this to detect "no real update happened" (e.g.
  // `commitMutations`' no-op check) doesn't see a no-op re-infer as a real
  // commit. Only the TEXT is compared — `titleMode`/`subtitleMode` are
  // derived bookkeeping (e.g. normalizing an unset mode to `'auto'` the
  // first time this runs on a widget that predates the auto/explicit split)
  // and shouldn't by themselves count as a change when the displayed text is
  // identical. `sameText` treats `undefined` and `''` as equivalent ("no
  // title/subtitle") — inferring an empty subtitle for a widget whose
  // `subtitle` field was simply never set is not a real change either.
  const sameText = (a: string | undefined, b: string | undefined) => a === b || (!a && !b);
  if (sameText(title, widget.title) && sameText(subtitle, widget.subtitle)) {
    return widget;
  }

  return { ...widget, title, titleMode, subtitle, subtitleMode };
}

/**
 * Shared write-side CHART-TYPE guard for every widget CREATION boundary
 * (defense-in-depth companion to `getDescriptor`'s `Object.hasOwn` guard in
 * `chartTypeRegistry.ts`): a widget can reach a create path with an
 * invalid/hostile `chartType` (e.g. a client-built widget that skipped
 * `createWidgetFromDescription.ts`'s own sanitization, or a future call site
 * that doesn't sanitize). `updateWidgetConfig`/`updateWidget` already validate
 * chart-type-appropriate keys on every UPDATE; this mirrors that
 * "validate at every mutation boundary" convention so a widget can never be
 * CREATED with a chart type outside the closed `StudioChartType` union.
 *
 * Called from ALL THREE creation entry points — {@link addWidget},
 * {@link insertWidgetAt} (public API, reached by the compose drawer's
 * drop-at-position path) and {@link duplicateWidget}'s clone. Previously only
 * `addWidget` ran it, so the convention its own comment claimed to uphold had
 * two holes: `insertWidgetAt` installed a hostile `chartType` verbatim, and
 * `duplicateWidget` then propagated it into the copy. The shared reducer's
 * `addWidget` handler validates record-ness and `kind`/`title` string-ness but
 * deliberately knows nothing about chart types, so this cannot move there.
 *
 * Mirrors `parseStateMutation.ts`'s `hasInvalidChartTypeInConfig`: an ABSENT (or
 * explicit `undefined`) `chartType` is sanctioned — it's the same "no discriminant
 * yet == bar" default `resolveChartType`/the AI middleware's `buildWidgetFromArgs`
 * apply — so only an OWN, non-undefined `chartType` that fails `isStudioChartType`
 * is repaired here. This keeps the guard from touching the many widgets created
 * with no `chartType` at all. Returns `widget` UNCHANGED (same reference) when
 * there is nothing to repair, so the no-op path allocates nothing.
 */
export const sanitizeWidgetForCreate = (widget: StudioWidget): StudioWidget => {
  if (widget.kind !== 'chart') {
    return widget;
  }
  const configRecord = widget.config as Record<string, unknown>;
  const hasOwnChartType =
    Object.hasOwn(configRecord, 'chartType') && configRecord.chartType !== undefined;
  if (!hasOwnChartType) {
    return widget;
  }
  const rawChartType = configRecord.chartType;
  if (typeof rawChartType === 'string' && isStudioChartType(rawChartType)) {
    return widget;
  }
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Widget '${widget.id}' was created with an invalid chartType ` +
        `'${String(rawChartType)}'. Falling back to 'bar'. Ensure the caller supplies a ` +
        'valid StudioChartType (see isStudioChartType).',
    );
  }
  // Repaired to 'bar', so also drop any config key that isn't valid for 'bar' —
  // a hostile/invalid `chartType` is commonly paired with keys authored for that
  // same bogus type.
  const effectiveChartType: StudioChartType = 'bar';
  const invalidChartKeys = validateChartConfigKeysForType(effectiveChartType, configRecord);
  const stripped = stripKeys(configRecord, invalidChartKeys);
  return {
    ...widget,
    config: { ...stripped, chartType: effectiveChartType } as StudioWidget['config'],
  };
};

/**
 * Shared write-side kind/chart-type sanitization for a widget's `config`,
 * factored out so both `updateWidgetConfig` (a merged config PATCH) and
 * `updateWidget`'s `changes.config` path (a wholesale config REPLACEMENT,
 * per `applyMutation.ts`'s `updateWidget` handler) run the identical guard
 * before their respective config value reaches the reducer. See the two call
 * sites for how the merge-vs-replacement distinction affects what "the
 * incoming config" means, but the validation itself — strip config keys not
 * valid for `kind`, then (for a chart) strip keys not valid for the
 * effective chart type — is identical either way.
 *
 * Composes the same shared primitives `sanitizeWidgetConfigForChartType`
 * (`internals/widgetConfigSanitization.ts`) is built from — `stripKeys` and
 * `resolveEffectiveChartType` — directly, rather than calling that function,
 * because this UPDATE path also needs to emit dev warnings naming exactly
 * which keys were dropped and why, which a bare sanitized-config return
 * can't carry back out.
 */
export const sanitizeWidgetConfigForKind = (
  kind: StudioWidget['kind'],
  config: Record<string, unknown>,
  widgetId: string,
  // The chart type to fall back to when `config` itself doesn't declare a
  // (valid) `chartType` (i.e. the widget's CURRENT stored chart type). Only
  // relevant when `kind === 'chart'`; omit when there's no sensible existing
  // chart type to fall back to (e.g. `kind` is itself changing away from
  // 'chart').
  existingChartConfig?: { chartType?: StudioChartType },
): Record<string, unknown> => {
  // Write-side kind guard: strip any config key that isn't valid for THIS
  // widget's kind before committing (e.g. a Chart-only key patched onto a Grid
  // widget). TypeScript can't enforce the per-kind config shape on this generic
  // patch at runtime, so this is the runtime backstop. Matching the controller's
  // guard-and-continue style (never throw on bad input): warn in dev and drop
  // the offending keys rather than persisting a wrong-kind key.
  const invalidKindKeys = validateConfigKeysForKind(kind, config);
  if (invalidKindKeys.length > 0 && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Ignoring config key(s) not valid for a '${kind}' ` +
        `widget (id '${widgetId}'): ${invalidKindKeys.join(', ')}. ` +
        'These keys belong to a different widget kind and were dropped from the update.',
    );
  }
  const kindStrippedConfig = stripKeys(config, invalidKindKeys);

  if (kind !== 'chart') {
    return kindStrippedConfig;
  }

  // Write-side CHART-TYPE guard: a finer-grained layer under the kind guard
  // above. A key can be a legitimate Chart key (passes the kind guard) yet still
  // be wrong for THIS chart's type (e.g. `sankeyTargetField` patched onto a
  // 'gauge' chart). Only the incoming config is checked here, never the widget's
  // STORED config: a chart widget deliberately retains config keys from a
  // previously-selected chart type after switching types (bar -> gauge -> bar
  // keeps `xField`/`ySeries` around) — that's intentional UX, not a bug, so
  // re-validating stored keys on every unrelated patch would wrongly strip them.
  // If the incoming config itself sets a VALID `chartType`, it's declaring a
  // type switch, so its own keys are checked against the NEW type; otherwise
  // fall back to the widget's CURRENT chart type (`existingChartConfig`). An
  // explicit but INVALID `chartType` is dropped and also falls back to the
  // existing type — warned about separately below, naming the bad value —
  // rather than being used verbatim (which would fail closed against an empty
  // allow-list and strip every remaining key).
  const chartTypeFallback = resolveChartType(existingChartConfig ?? {});
  const { chartType: effectiveChartType, wasInvalidExplicit } = resolveEffectiveChartType(
    (kindStrippedConfig as { chartType?: unknown }).chartType,
    chartTypeFallback,
  );
  if (wasInvalidExplicit && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Ignoring an invalid chartType ` +
        `'${String((kindStrippedConfig as { chartType?: unknown }).chartType)}' in the config ` +
        `update for widget (id '${widgetId}'). Falling back to '${effectiveChartType}'.`,
    );
  }
  const configForChartTypeCheck = wasInvalidExplicit
    ? stripKeys(kindStrippedConfig, ['chartType'])
    : kindStrippedConfig;

  const invalidChartKeys = validateChartConfigKeysForType(
    effectiveChartType,
    configForChartTypeCheck,
  );
  if (invalidChartKeys.length > 0 && process.env.NODE_ENV !== 'production') {
    console.warn(
      `MUI X Studio: Ignoring config key(s) not valid for chart type '${effectiveChartType}' ` +
        `(widget id '${widgetId}'): ${invalidChartKeys.join(', ')}. ` +
        'These keys belong to a different chart type and were dropped from the update.',
    );
  }

  return stripKeys(configForChartTypeCheck, invalidChartKeys);
};
