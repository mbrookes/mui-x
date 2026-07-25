import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import type { StudioWidget } from '../../models';
import { WidgetInstanceList } from './WidgetInstanceList';

const { render } = createRenderer();

function renderList(widget: StudioWidget) {
  const { wrapper } = createStudioHarness({
    initialState: {
      doc: {
        widgets: { [widget.id]: widget },
        pages: {
          'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] },
        },
      },
    },
  });
  render(<WidgetInstanceList kind={widget.kind} onBack={() => {}} onAdd={() => {}} />, { wrapper });
}

describe('WidgetInstanceList', () => {
  it('renders the localized widget-kind label as the fallback for an untitled widget', () => {
    renderList({ id: 'w1', kind: 'kpi', title: '', config: {} } as StudioWidget);
    // The panel header (`wt.label`) also reads "KPI", so scope the assertion to the
    // per-instance item itself (`aria-label="Select widget: kpi"`) to avoid ambiguity.
    const item = screen.getByRole('button', { name: 'Select widget: kpi' });
    expect(within(item).getByText('KPI')).not.toBe(null);
  });

  // Architecture review finding (Tier2): `widget.kind` is doc-authored, so an unguarded
  // `widgetKindLabels[widget.kind]` bracket lookup that resolves an inherited
  // `Object.prototype` member (e.g. `kind: 'constructor'` — a persisted-doc/AI-authored/
  // custom-widget kind string) must not surface the inherited function here either. This
  // list is contained by the Compose drawer's own error boundary, but the fix mirrors
  // `StudioWidgetCard.tsx`'s guard for consistency.
  it('does not throw and renders no crash-inducing label for an untitled widget whose kind collides with an Object.prototype member', () => {
    expect(() =>
      renderList({ id: 'w1', kind: 'constructor', title: '', config: {} } as StudioWidget),
    ).not.toThrow();
  });
});
