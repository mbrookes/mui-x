/**
 * Locale completeness tests — verify that each non-English locale bundle
 * defines every key that exists in the reference ptBR bundle.
 *
 * ptBR is used as the reference rather than enUS because it is the only
 * non-English bundle that existed before the fr/de/es bundles were added,
 * and its token set is known-complete.
 */
import { describe, it, expect } from 'vitest';
import { ptBRLocaleText } from './ptBR';
import { frLocaleText } from './fr';
import { deLocaleText } from './de';
import { esLocaleText } from './es';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../internals/StudioUIConfigContext';

const REFERENCE_KEYS = Object.keys(ptBRLocaleText) as Array<keyof typeof ptBRLocaleText>;

const BUNDLES: Array<{ name: string; locale: Partial<typeof ptBRLocaleText> }> = [
  { name: 'fr', locale: frLocaleText },
  { name: 'de', locale: deLocaleText },
  { name: 'es', locale: esLocaleText },
];

describe('locale completeness', () => {
  it.each(BUNDLES)('$name defines all keys present in ptBR', ({ name, locale }) => {
    const missing = REFERENCE_KEYS.filter((key) => !(key in locale));
    expect(
      missing,
      `${name} is missing ${missing.length} key(s): ${missing.join(', ')}`,
    ).toHaveLength(0);
  });

  it.each(BUNDLES)('$name has no empty string values', ({ name, locale }) => {
    const empty = Object.entries(locale)
      .filter(([, v]) => typeof v === 'string' && v.trim() === '')
      .map(([k]) => k);
    expect(empty, `${name} has empty string values for: ${empty.join(', ')}`).toHaveLength(0);
  });

  it.each(BUNDLES)('$name has no undefined/null values', ({ name, locale }) => {
    const nullish = Object.entries(locale)
      .filter(([, v]) => v == null)
      .map(([k]) => k);
    expect(nullish, `${name} has null/undefined values for: ${nullish.join(', ')}`).toHaveLength(0);
  });

  // `ptBR` predates several `DEFAULT_STUDIO_LOCALE_TEXT` sections (it's the reference for
  // the *other* bundles above, not a guaranteed 1:1 mirror of every default key), so a
  // blanket "every default key is in ptBR" check would fail today on ~100 pre-existing,
  // unrelated gaps. Scope the regression guard to the keys this change actually added,
  // so a future accidental default-only key in one of *these* tokens still fails CI.
  const NEW_LOCALE_KEYS: Array<keyof typeof DEFAULT_STUDIO_LOCALE_TEXT> = [
    'widgetAiRefreshTooltip',
    'widgetInsightTypeSummary',
    'widgetInsightTypeAnalysis',
    'widgetInsightTypeForecast',
    'aiAssistantPanelTitle',
    'chartHeatmapRequiresFieldsHint',
    'chartFunnelRequiresFieldsHint',
    'chartSankeyRequiresFieldsHint',
    'chartGanttRequiresFieldsHint',
    'chatNoConversationsLabel',
    'chatComposerPlaceholder',
    'chatEmptyStateTitle',
    'chatEmptyStateSubtitle',
    'canvasEmptyTitle',
    'canvasEmptyEditModeHint',
    'canvasEmptyViewModeHint',
    'mapLegendAriaLabel',
    'exprOpAdd',
    'exprOpSubtract',
    'exprOpMultiply',
    'exprOpDivide',
    'exprOpModulo',
    'exprOpNegate',
    'exprOpEquals',
    'exprOpNotEqual',
    'exprOpLessThan',
    'exprOpGreaterThan',
    'exprOpLessThanOrEqual',
    'exprOpGreaterThanOrEqual',
    'exprOpAnd',
    'exprOpOr',
    'exprOpNot',
    'exprOpIsTrue',
    'exprOpIsFalse',
    'exprOpIsNull',
    'exprOpIsNotNull',
    'exprOpIf',
    'exprOpIn',
    'exprOpDatediff',
    'exprGroupArithmetic',
    'exprGroupComparison',
    'exprGroupLogical',
    'exprGroupConditional',
    'exprGroupDate',
    'exprInputLabelUnit',
    'exprInputLabelCondition',
    'exprInputLabelThen',
    'exprInputLabelElse',
    'exprInputLabelGeneric',
    'exprAddInputButton',
    'exprOutputTypeLabel',
    'kpiTrendVsLabel',
  ];

  it('every newly-added locale key is present in the ptBR reference bundle', () => {
    const missing = NEW_LOCALE_KEYS.filter((key) => !(key in ptBRLocaleText));
    expect(
      missing,
      `ptBR is missing ${missing.length} newly-added key(s): ${missing.join(', ')}`,
    ).toHaveLength(0);
  });
});
