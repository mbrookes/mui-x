import { describe, expect, it } from 'vitest';
import { getDefaultCrossFilterFieldId } from './StudioGridWidget';
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

describe('getDefaultCrossFilterFieldId', () => {
  it('uses the first configured grid column when no cross-filter field is selected', () => {
    const widget = makeWidget({ config: { columns: ['amount', 'status'] } });

    expect(getDefaultCrossFilterFieldId(widget, makeDataSource())).toBe('amount');
  });

  it('falls back to the first visible source field when no columns are configured', () => {
    const dataSource = {
      ...makeDataSource(),
      fields: [
        { id: 'hidden-id', label: 'Hidden ID', type: 'string', hidden: true },
        { id: 'amount', label: 'Amount', type: 'number' },
        { id: 'status', label: 'Status', type: 'string' },
      ],
    } satisfies StudioDataSource;

    expect(getDefaultCrossFilterFieldId(makeWidget(), dataSource)).toBe('amount');
  });
});