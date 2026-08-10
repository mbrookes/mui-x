import * as React from 'react';
import { createDefaultSemanticModel } from '@mui/x-studio-core/models';
import { createRenderer, flushMicrotasks } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type {
  CreateDefaultStudioStateOverrides,
  StudioDataSource,
  StudioExpressionField,
  StudioRelationship,
  StudioWidgetOf,
} from '../../../models';
import { createStudioHarness } from '../../../internals/test-utils';
import { StudioGridWidget, resolveCrossSourceFieldDefs } from './StudioGridWidget';

const { render } = createRenderer();

// ─── Related-source EXPRESSION (calculated) columns render resolved values (finding 2.3) ──
//
// `GridSetupPanel` offers a related source's calculated column (a non-measure expression
// field owned by that source) as a selectable grid column, but it was resolvable nowhere:
//   1. `resolveCrossSourceFieldDefs` looked only at `dataSources[c.sourceId].fields`, so no
//      column def was built and the column never rendered.
//   2. the cross-source enrichment indexed the related source's RAW rows, which carry no
//      value for a calculated column, so every cell resolved to `undefined`.
// The fix resolves the def from the related source's expression fields AND routes that
// source's rows through the shared L2 pass before enriching, so the column renders a value.

const relationship: StudioRelationship = {
  id: 'rel-orders-customers',
  type: 'many-to-one',
  sourceId: 'orders',
  sourceField: 'customerId',
  targetId: 'customers',
  targetField: 'id',
};

// customers.bonus = spend * 2 — a calculated column owned by the customers (related) source.
const bonusExpr: StudioExpressionField = {
  id: 'bonus',
  label: 'Bonus',
  sourceId: 'customers',
  isMeasure: false,
  expression: {
    operator: 'multiply',
    inputs: [{ id: 'spend' }, { type: 'number', value: 2 }],
  },
} as unknown as StudioExpressionField;

function makeOrdersSource(): StudioDataSource {
  return {
    id: 'orders',
    label: 'Orders',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'customerId', label: 'Customer', type: 'string' },
    ],
    rows: [
      { id: 'o1', customerId: 'c1' },
      { id: 'o2', customerId: 'c2' },
    ],
  };
}

function makeCustomersSource(): StudioDataSource {
  return {
    id: 'customers',
    label: 'Customers',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'spend', label: 'Spend', type: 'number' },
    ],
    rows: [
      { id: 'c1', spend: 100 },
      { id: 'c2', spend: 50 },
    ],
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'orders',
    config: {
      columns: [{ fieldId: 'id' }, { fieldId: 'bonus', sourceId: 'customers' }],
    },
  };
}

async function setup() {
  const orders = makeOrdersSource();
  const customers = makeCustomersSource();
  const widget = makeWidget();
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      semanticModel: {
        ...createDefaultSemanticModel(),
        relationships: [relationship],
        expressionFields: [bonusExpr],
      },

      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { orders, customers } },
  };
  const { controller, wrapper } = createStudioHarness({ initialState });
  // The `columns` override only fixes each column's width/type (flex columns compute to 0
  // width in jsdom, so cell text never renders otherwise); it does NOT touch the ROW data,
  // which still flows through the widget's own row memo — so asserting the `bonus` cell text
  // exercises the real supplemental L2 enrichment. The production column-DEF path
  // (`resolveCrossSourceFieldDefs`'s expression fallback) is covered by the unit tests above.
  const utils = render(
    <StudioGridWidget
      widget={widget}
      dataSource={orders}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'id', width: 100 },
            { field: 'bonus', width: 100, type: 'number' },
          ],
        },
      }}
    />,
    { wrapper },
  );
  await flushMicrotasks();
  return { controller, ...utils };
}

function cellText(container: HTMLElement, rowId: string, field: string): string | null {
  return (
    container.querySelector(`[data-id="${rowId}"] [data-field="${field}"]`)?.textContent ?? null
  );
}

describe('resolveCrossSourceFieldDefs — related-source expression fallback (finding 2.3)', () => {
  it('builds a column def for a related-source calculated column from expressionFields', () => {
    const defs = resolveCrossSourceFieldDefs(
      [{ fieldId: 'id' }, { fieldId: 'bonus', sourceId: 'customers' }],
      'orders',
      { orders: makeOrdersSource(), customers: makeCustomersSource() },
      [bonusExpr],
    );
    expect(defs.get('bonus')).toMatchObject({ id: 'bonus', label: 'Bonus', type: 'number' });
  });

  it('omits the related-source calculated column when expressionFields are not supplied', () => {
    const defs = resolveCrossSourceFieldDefs(
      [{ fieldId: 'bonus', sourceId: 'customers' }],
      'orders',
      { orders: makeOrdersSource(), customers: makeCustomersSource() },
    );
    expect(defs.has('bonus')).toBe(false);
  });
});

describe('StudioGridWidget — a related-source calculated column renders resolved values', () => {
  it('renders the L2-computed value (bonus = spend * 2) for each row', async () => {
    const { container } = await setup();
    // c1 spend 100 → bonus 200; c2 spend 50 → bonus 100.
    expect(cellText(container, 'o1', 'bonus')).toBe('200');
    expect(cellText(container, 'o2', 'bonus')).toBe('100');
  });
});
