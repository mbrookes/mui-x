import { describe, expect, it } from 'vitest';
import {
  getAllowedChartConfigKeys,
  getAllowedConfigKeys,
  isStudioChartType,
} from './models/studioTypes';
import type { BuiltinStudioWidgetKind } from './models/studioTypes';
import {
  CHART_TYPE_DOCS,
  KIND_CONFIG_LINES,
  KPI_SPARKLINE_DOC,
  WIDGET_KIND_DESCRIPTIONS,
} from './widgetConfigMeta';

/**
 * Tokens that look like config keys (camelCase) but are documented as SUB-object
 * property names (e.g. `ySeries` entries carry `{ fieldId, sourceId, ... }`) or
 * as the widget-level `sourceId`, none of which are top-level config keys. They
 * must be excluded from the drift check.
 */
const NON_CONFIG_KEY_TOKENS = new Set(['fieldId', 'sourceId']);

/**
 * Extracts the camelCase identifiers documented in a metadata string that look
 * like config keys. Brace groups (`{ ... }` — sub-object shapes) are stripped
 * first so their inner property names don't count as top-level keys. Value words
 * are lowercase-only (e.g. `horizontal`, `asc`, `bar-100`) and never match the
 * camelCase pattern, so only real key candidates survive.
 */
function extractDocumentedKeys(text: string): string[] {
  const withoutBraces = text.replace(/\{[^}]*\}/g, ' ');
  const matches = withoutBraces.match(/\b[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*\b/g) ?? [];
  return matches.filter((token) => !NON_CONFIG_KEY_TOKENS.has(token));
}

describe('widgetConfigMeta: documented keys stay in sync with the schema allowlist', () => {
  it('every kind in KIND_CONFIG_LINES documents only keys the schema allows for that kind', () => {
    const kinds = Object.keys(KIND_CONFIG_LINES) as BuiltinStudioWidgetKind[];
    for (const kind of kinds) {
      const allowed = getAllowedConfigKeys(kind);
      expect(allowed, `no allowlist for kind ${kind}`).not.toBeNull();
      const documented = extractDocumentedKeys(KIND_CONFIG_LINES[kind].join('\n'));
      const stray = documented.filter((key) => !allowed!.has(key));
      expect(stray, `kind "${kind}" documents keys not in the schema allowlist`).toEqual([]);
    }
  });

  it('every chart-type line in CHART_TYPE_DOCS documents only keys valid for that chart type', () => {
    for (const entry of CHART_TYPE_DOCS) {
      const colon = entry.indexOf(':');
      expect(colon, `no "type: ..." separator in "${entry}"`).toBeGreaterThan(0);
      const types = entry
        .slice(0, colon)
        .split('/')
        .map((t) => t.trim());
      const documented = extractDocumentedKeys(entry.slice(colon + 1));
      for (const type of types) {
        expect(isStudioChartType(type), `"${type}" is not a StudioChartType`).toBe(true);
        const allowed = getAllowedChartConfigKeys(type as any);
        const stray = documented.filter((key) => !allowed.has(key));
        expect(stray, `chart type "${type}" documents keys not in its schema allowlist`).toEqual(
          [],
        );
      }
    }
  });

  it('KPI_SPARKLINE_DOC documents only valid KPI config keys', () => {
    const allowed = getAllowedConfigKeys('kpi')!;
    const stray = extractDocumentedKeys(KPI_SPARKLINE_DOC).filter((key) => !allowed.has(key));
    expect(stray).toEqual([]);
  });

  // Finding 2-5: sankey is a real closed-union chart type with a schema config family,
  // but was undocumented for the LLM. It must now appear in every doc surface.
  it('documents the sankey chart type across all AI-facing surfaces', () => {
    expect(isStudioChartType('sankey')).toBe(true);
    // Chart kind one-liner and config lines
    expect(WIDGET_KIND_DESCRIPTIONS.chart).toContain('sankey');
    expect(KIND_CONFIG_LINES.chart.join('\n')).toMatch(/sankey:/);
    // Dedicated CHART_TYPE_DOCS entry
    const sankeyEntry = CHART_TYPE_DOCS.find((entry) => entry.startsWith('sankey:'));
    expect(sankeyEntry, 'CHART_TYPE_DOCS has no sankey entry').toBeDefined();
    // The sankey-only key is documented and schema-valid for sankey
    expect(sankeyEntry).toContain('sankeyTargetField');
    expect(getAllowedChartConfigKeys('sankey').has('sankeyTargetField')).toBe(true);
  });

  it('documents every built-in widget kind', () => {
    expect(Object.keys(KIND_CONFIG_LINES).sort()).toEqual(
      Object.keys(WIDGET_KIND_DESCRIPTIONS).sort(),
    );
  });

  // Regression guards for the two specific drifts fixed in finding 1.2.
  it('does not document the grid-only crossFilterField key under chart', () => {
    const chartDocs = KIND_CONFIG_LINES.chart.join('\n');
    expect(chartDocs).not.toContain('crossFilterField');
    // crossFilterField is a real key, but only on grid — confirm the schema agrees.
    expect(getAllowedChartConfigKeys('bar').has('crossFilterField')).toBe(false);
    expect(getAllowedConfigKeys('grid')!.has('crossFilterField')).toBe(true);
  });

  it('does not document the non-existent kpiSparklineGaugeMin key anywhere', () => {
    const allText = [
      ...Object.values(KIND_CONFIG_LINES).flat(),
      ...CHART_TYPE_DOCS,
      KPI_SPARKLINE_DOC,
    ].join('\n');
    expect(allText).not.toContain('kpiSparklineGaugeMin');
    expect(getAllowedConfigKeys('kpi')!.has('kpiSparklineGaugeMin')).toBe(false);
    // The real key that survives is the Max bound.
    expect(getAllowedConfigKeys('kpi')!.has('kpiSparklineGaugeMax')).toBe(true);
  });
});
