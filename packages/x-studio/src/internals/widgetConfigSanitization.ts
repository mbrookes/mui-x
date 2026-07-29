import {
  validateConfigKeysForKind,
  validateChartConfigKeysForType,
  isStudioChartType,
} from '@mui/x-studio-schema';
import type { StudioChartType, StudioWidgetKind } from '../models';

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
