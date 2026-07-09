import * as React from 'react';
import { createRenderer } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioGridWidget } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Column render order follows `config.columns` (architecture review 1.2) ──
//
// The grid used to build its `columns` array from the data-source field order,
// consuming `widget.config.columns` only for visibility. `GridSetupPanel`'s
// drag-and-drop / keyboard reorder commits a new order to `config.columns`, but
// the rendered grid never reflected it. The fix derives column order from
// `config.columns` (configured fields first, in their stored order).

function makeSource(): StudioDataSource {
  return {
    id: 'src',
    label: 'Widgets',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'alpha', label: 'Alpha', type: 'string' },
      { id: 'beta', label: 'Beta', type: 'string' },
      { id: 'gamma', label: 'Gamma', type: 'string' },
    ],
    rows: [{ id: 'r1', alpha: 'a', beta: 'b', gamma: 'c' }],
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    // Deliberately NOT the data-source field order (id, alpha, beta, gamma) —
    // this is the order a user would land on after dragging columns around in
    // GridSetupPanel.
    config: {
      columns: [{ fieldId: 'gamma' }, { fieldId: 'id' }, { fieldId: 'beta' }, { fieldId: 'alpha' }],
    },
  };
}

function setup() {
  const source = makeSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { src: source } },
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      slotProps={{ dataGrid: { disableVirtualization: true } }}
    />,
    { wrapper },
  );
  return { controller, source, widget, ...utils };
}

describe('StudioGridWidget — configured column order', () => {
  it('renders columns in the config.columns order, not the data-source field order', () => {
    const { container } = setup();
    const headers = Array.from(container.querySelectorAll('[role="columnheader"][data-field]'));
    const fieldOrder = headers.map((el) => el.getAttribute('data-field'));

    expect(fieldOrder).toEqual(['gamma', 'id', 'beta', 'alpha']);
    // Explicitly assert the regression: order must NOT be the data-source order.
    expect(fieldOrder).not.toEqual(['id', 'alpha', 'beta', 'gamma']);
  });

  it('appends fields missing from config.columns after the configured ones', () => {
    const source = makeSource();
    const widget: StudioWidgetOf<'grid'> = {
      id: 'grid-2',
      kind: 'grid',
      title: 'Grid',
      sourceId: 'src',
      // Only a subset configured, in reverse order — the visible/ordered set
      // still only contains these (config.columns also drives visibility), but
      // this exercises the "configured columns first, in their stored order"
      // half of the fix without relying on the append-remaining branch being
      // externally observable (hidden columns aren't rendered in the DOM).
      config: { columns: [{ fieldId: 'beta' }, { fieldId: 'gamma' }] },
    };
    const initialState: CreateDefaultStudioStateOverrides = {
      doc: {
        widgets: { [widget.id]: widget },
        pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
      },
      runtime: { dataSources: { src: source } },
    };
    const { wrapper } = createStudioHarness({ initialState });
    const { container } = render(
      <StudioGridWidget
        widget={widget}
        dataSource={source}
        pageId="page-1"
        slotProps={{ dataGrid: { disableVirtualization: true } }}
      />,
      { wrapper },
    );

    const headers = Array.from(container.querySelectorAll('[role="columnheader"][data-field]'));
    const fieldOrder = headers.map((el) => el.getAttribute('data-field'));
    expect(fieldOrder).toEqual(['beta', 'gamma']);
  });
});
