import { describe, expect, it } from 'vitest';
import { buildAISystemPrompt } from './buildAISystemPrompt';
import { createDefaultStudioState } from '../models/stateTypes';
import type { StudioDataSource, StudioFilterState, StudioWidget } from '../models';

const PAGE_ID = 'page-1';

function makeState(overrides?: Parameters<typeof createDefaultStudioState>[0]) {
  return createDefaultStudioState({
    dashboard: { id: 'd1', title: 'Test Dashboard', activePageId: PAGE_ID },
    pages: {
      [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [] },
    },
    ...overrides,
  });
}

function makeSource(overrides?: Partial<StudioDataSource>): StudioDataSource {
  return {
    id: 'src1',
    label: 'Sales',
    fields: [{ id: 'revenue', label: 'Revenue', type: 'number' }],
    ...overrides,
  } as StudioDataSource;
}

function makeWidget(id: string, overrides?: Partial<StudioWidget>): StudioWidget {
  return {
    id,
    kind: 'chart',
    title: 'Revenue Chart',
    sourceId: 'src1',
    config: { chartType: 'bar', xField: 'month', yField: 'revenue' },
    ...overrides,
  } as StudioWidget;
}

function makeFilter(overrides: Partial<StudioFilterState>): StudioFilterState {
  return {
    id: 'f1',
    field: 'revenue',
    operator: 'greater_than',
    value: 100,
    scope: 'page',
    pageId: PAGE_ID,
    ...overrides,
  } as StudioFilterState;
}

// ── Static instruction sections ───────────────────────────────────────────────

describe('buildAISystemPrompt: static instruction sections', () => {
  const state = makeState();

  it('includes terseness rule', () => {
    expect(buildAISystemPrompt(state)).toContain('Be terse');
  });

  it('includes duplicate-prevention rule', () => {
    expect(buildAISystemPrompt(state)).toContain('exactly once per turn');
  });

  it('includes field-name guardrail', () => {
    expect(buildAISystemPrompt(state)).toContain('Never invent widget IDs');
  });

  it('includes idempotency rule', () => {
    expect(buildAISystemPrompt(state)).toContain('already correct, respond in text only');
  });

  it('includes decision algorithm', () => {
    expect(buildAISystemPrompt(state)).toContain('Decision Algorithm');
  });

  it('includes refusal posture', () => {
    expect(buildAISystemPrompt(state)).toContain('not supported by the available tools');
  });

  it('includes common patterns section', () => {
    expect(buildAISystemPrompt(state)).toContain('Common Patterns');
  });

  it('includes shape confusions section', () => {
    expect(buildAISystemPrompt(state)).toContain('Common Mistakes');
  });

  it('includes security rules', () => {
    expect(buildAISystemPrompt(state)).toContain('Security Rules');
  });
});

// ── Dynamic state structure ───────────────────────────────────────────────────

describe('buildAISystemPrompt: dynamic state structure', () => {
  it('wraps dashboard state in <dashboard_state> tags', () => {
    const state = makeState();
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('<dashboard_state>');
    expect(prompt).toContain('</dashboard_state>');
  });

  it('includes current date in ISO format (YYYY-MM-DD)', () => {
    const state = makeState();
    const prompt = buildAISystemPrompt(state);
    const today = new Date().toISOString().slice(0, 10);
    expect(prompt).toContain(today);
  });

  it('static instructions appear before dynamic state', () => {
    const state = makeState();
    const prompt = buildAISystemPrompt(state);
    // Decision Algorithm is in static instructions; ## Current Date is the first line
    // of the dynamic <dashboard_state> block — so instructions must precede it.
    expect(prompt.indexOf('Decision Algorithm')).toBeLessThan(prompt.indexOf('## Current Date'));
  });
});

// ── aiDescription ─────────────────────────────────────────────────────────────

describe('buildAISystemPrompt: aiDescription', () => {
  it('includes aiDescription on a data source', () => {
    const source = makeSource({ aiDescription: 'Quarterly sales data for all regions.' });
    const state = makeState({ dataSources: { src1: source } });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('Quarterly sales data for all regions.');
  });

  it('includes aiDescription on a data field', () => {
    const source = makeSource({
      fields: [
        {
          id: 'revenue',
          label: 'Revenue',
          type: 'number',
          aiDescription: 'Net revenue in USD excluding returns.',
        },
      ],
    });
    const state = makeState({ dataSources: { src1: source } });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('Net revenue in USD excluding returns.');
  });

  it('does not crash when aiDescription is absent', () => {
    const source = makeSource();
    const state = makeState({ dataSources: { src1: source } });
    expect(() => buildAISystemPrompt(state)).not.toThrow();
  });
});

// ── Pivot / Map widget descriptions ──────────────────────────────────────────

describe('buildAISystemPrompt: pivot and map widget descriptions', () => {
  it('includes pivot rowField, colField, valueField', () => {
    const widget = makeWidget('w1', {
      kind: 'pivot',
      config: { pivotRowField: 'region', pivotColField: 'quarter', pivotValueField: 'revenue' },
    });
    const state = makeState({
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [['w1']] } },
      widgets: { w1: widget },
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('region');
    expect(prompt).toContain('quarter');
    expect(prompt).toContain('revenue');
  });

  it('includes map countryField and valueField', () => {
    const widget = makeWidget('w1', {
      kind: 'map',
      config: { mapCountryField: 'country', mapValueField: 'sales' },
    });
    const state = makeState({
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [['w1']] } },
      widgets: { w1: widget },
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('country');
    expect(prompt).toContain('sales');
  });
});

// ── Active filters ────────────────────────────────────────────────────────────

describe('buildAISystemPrompt: active filters', () => {
  it('includes page-scoped filter for the active page', () => {
    const filter = makeFilter({ id: 'f1', scope: 'page', pageId: PAGE_ID });
    const state = makeState({ filters: [filter] });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('f1');
    expect(prompt).toContain('revenue');
  });

  it('does not include page-scoped filter for a different page', () => {
    const filter = makeFilter({ id: 'f-other', scope: 'page', pageId: 'other-page' });
    const state = makeState({ filters: [filter] });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).not.toContain('f-other');
  });

  it('includes widget-scoped filter for widget on the active page', () => {
    const widget = makeWidget('w1');
    const filter = makeFilter({
      id: 'fw1',
      scope: 'widget',
      widgetId: 'w1',
      pageId: undefined,
    } as Partial<StudioFilterState>);
    const state = makeState({
      pages: { [PAGE_ID]: { id: PAGE_ID, title: 'Page 1', widgetRows: [['w1']] } },
      widgets: { w1: widget },
      filters: [filter],
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).toContain('fw1');
  });

  it('does not include widget-scoped filter for widget not on the active page', () => {
    const widget = makeWidget('w2');
    const filter = makeFilter({
      id: 'fw2',
      scope: 'widget',
      widgetId: 'w2',
    } as Partial<StudioFilterState>);
    const state = makeState({
      // w2 is NOT in the active page's widgetRows
      widgets: { w2: widget },
      filters: [filter],
    });
    const prompt = buildAISystemPrompt(state);
    expect(prompt).not.toContain('fw2');
  });

  it('includes no filters section when filters array is empty', () => {
    const state = makeState({ filters: [] });
    const prompt = buildAISystemPrompt(state);
    // Prompt should still be generated without errors
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});

// ── Skill section ─────────────────────────────────────────────────────────────

describe('skill section', () => {
  it('omits the Skills section when no skills are provided', () => {
    const state = makeState();
    const prompt = buildAISystemPrompt(state);
    expect(prompt).not.toContain('## Skills');
  });

  it('omits the Skills section when an empty skills array is provided', () => {
    const state = makeState();
    const prompt = buildAISystemPrompt(state, undefined, undefined, []);
    expect(prompt).not.toContain('## Skills');
  });

  it('includes the Skills section when skills are provided', () => {
    const state = makeState();
    const skill = {
      name: 'testSkill',
      mode: 'instruction-only' as const,
      promptFragment: 'Trigger: say "test". Respond in plain text.',
    };
    const prompt = buildAISystemPrompt(state, undefined, undefined, [skill]);
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('<skill name="testSkill" mode="instruction-only">');
    expect(prompt).toContain('Trigger: say "test".');
    expect(prompt).toContain('</skill>');
  });

  it('includes all skills when multiple are provided', () => {
    const state = makeState();
    const skills = [
      { name: 'skillA', mode: 'instruction-only' as const, promptFragment: 'Fragment A' },
      { name: 'skillB', mode: 'client-handler' as const, promptFragment: 'Fragment B' },
    ];
    const prompt = buildAISystemPrompt(state, undefined, undefined, skills);
    expect(prompt).toContain('<skill name="skillA" mode="instruction-only">');
    expect(prompt).toContain('<skill name="skillB" mode="client-handler">');
    expect(prompt).toContain('Fragment A');
    expect(prompt).toContain('Fragment B');
  });

  it('places the Skills section between instructions and dashboard_state', () => {
    const state = makeState();
    const skill = {
      name: 'mySkill',
      mode: 'instruction-only' as const,
      promptFragment: 'Some instruction.',
    };
    const prompt = buildAISystemPrompt(state, undefined, undefined, [skill]);
    const skillPos = prompt.indexOf('## Skills');
    // Use lastIndexOf because <dashboard_state> also appears inside the instructions text
    // (in the guardrail rule). The actual dashboard state block is the final occurrence.
    const statePos = prompt.lastIndexOf('<dashboard_state>');
    expect(skillPos).toBeGreaterThan(0);
    expect(statePos).toBeGreaterThan(skillPos);
  });
});
