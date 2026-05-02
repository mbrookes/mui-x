import { describe, expect, it } from 'vitest';
import type { StudioDataSource, StudioWidget } from '../models';

function makeWidget(overrides: Partial<StudioWidget> = {}): StudioWidget {
  return {
    id: 'widget-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'orders',
    config: {},
    ...overrides,
  };
}

function makeDataSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
      { id: 'status', label: 'Status', type: 'string' },
    ],
    rows: [],
  };
}

describe('StudioGridWidget', () => {
  it('makeWidget produces a valid grid widget', () => {
    const widget = makeWidget();
    expect(widget.kind).toBe('grid');
  });

  it('makeDataSource produces a valid data source', () => {
    const ds = makeDataSource();
    expect(ds.fields).toHaveLength(3);
  });
});