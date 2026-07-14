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

  // ── privateMode: no raw x-axis / data values leak (regression: 1.4) ──────────
  //
  // With `aiConfig.privateMode` on, an anomaly annotation's `value` (a literal
  // x-axis data value — a date, region, customer name, or a numeric measure) must
  // never be interpolated into the outgoing chat message. Every other prompt
  // builder in this package already enforces this trust boundary; this pins the
  // "explain anomalies" path so the value lines are omitted under private mode.
  it('omits raw annotation values when privateMode is on', () => {
    const annotations: StudioChartAnnotation[] = [
      // Sensitive x-axis label + a numeric measure — neither may appear.
      { id: 'a1', axis: 'x', value: 'Acme Corp — West Region', label: 'Spike' },
      { id: 'a2', axis: 'y', value: 987654 },
    ];
    const prompt = buildAnomalyExplainPrompt('Sales trend', annotations, true);

    // Widget title (schema-allowed) is still fine to send.
    expect(prompt).toContain('Sales trend');
    // No per-annotation value line survives.
    expect(prompt).not.toContain('Acme Corp');
    expect(prompt).not.toContain('West Region');
    expect(prompt).not.toContain('987654');
    expect(prompt.split('\n').some((line) => line.startsWith('-'))).toBe(false);
    // The count is still conveyed so the LLM knows how many were found.
    expect(prompt).toContain('2');
  });

  it('still embeds annotation values when privateMode is off (explicit false)', () => {
    const annotations: StudioChartAnnotation[] = [
      { id: 'a1', axis: 'x', value: 'Acme Corp', label: 'Spike' },
    ];
    const prompt = buildAnomalyExplainPrompt('Sales trend', annotations, false);
    expect(prompt).toContain('Acme Corp');
  });
});
