import { describe, expect, it } from 'vitest';
import type { StudioChartAnnotation } from '../../models/widgetTypes';
import {
  buildInsightPrompt,
  buildAnomalyExplainPrompt,
  type StudioWidgetInsightType,
} from './widgetInsightPrompts';

describe('buildInsightPrompt', () => {
  const types: StudioWidgetInsightType[] = ['summary', 'analysis', 'forecast', 'correlation'];

  it.each(types)('includes the widget title in the "%s" prompt', (type) => {
    const prompt = buildInsightPrompt(type, 'Revenue by region');
    expect(prompt).toContain('Revenue by region');
  });

  it('produces distinct prompts for each insight type', () => {
    const prompts = types.map((type) => buildInsightPrompt(type, 'My widget'));
    expect(new Set(prompts).size).toBe(types.length);
  });
});

describe('buildAnomalyExplainPrompt', () => {
  it('includes the widget title and one line per annotation', () => {
    const annotations: StudioChartAnnotation[] = [
      { id: 'a1', axis: 'x', value: '2024-01-01', label: 'Spike' },
      { id: 'a2', axis: 'y', value: 42 },
    ];
    const prompt = buildAnomalyExplainPrompt('Sales trend', annotations);
    expect(prompt).toContain('Sales trend');
    const lines = prompt.split('\n').filter((line) => line.startsWith('-'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('X-axis');
    expect(lines[0]).toContain('Spike');
    expect(lines[1]).toContain('Y-axis');
  });
});
