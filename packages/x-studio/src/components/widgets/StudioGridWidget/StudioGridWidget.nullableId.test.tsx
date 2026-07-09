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

// ─── getRowId fallback — nullable `id` column regression (finding 1.9) ────────
//
// The row-id mapping used to place the synthetic-id fallback BEFORE spreading the
// raw row:
//   { id: row.id ?? `${widget.id}-${index}`, ...row }
// For a source whose rows carry an `id` PROPERTY that is null/undefined (a nullable
// database id column), `...row` overwrote the computed id back to nullish, so every
// such row resolved to the same DataGrid id and collided. The fix spreads `row`
// first and sets `id` last, so the `??` fallback always wins when `row.id` is nullish.

function makeNullableIdSource(): StudioDataSource {
  return {
    id: 'src',
    label: 'Events',
    fields: [
      // An explicit `id` column — but every row's value is null (nullable in the DB).
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'category', label: 'Category', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { id: null, category: 'a', amount: 1 },
      { id: null, category: 'b', amount: 2 },
      { id: null, category: 'c', amount: 3 },
    ],
  };
}

function makeWidget(): StudioWidgetOf<'grid'> {
  return {
    id: 'grid-1',
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: {},
  };
}

function setup() {
  const source = makeNullableIdSource();
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
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'category', width: 100 },
            { field: 'amount', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
  return { controller, source, widget, ...utils };
}

describe('StudioGridWidget — nullable id column falls back to synthetic ids', () => {
  it('assigns distinct synthetic ids so every row renders (no collision)', () => {
    const { container } = setup();
    // Each row gets its positional synthetic id `${widget.id}-${index}` because its
    // real `id` value is null. Under the bug they all collapsed to a single null id.
    expect(container.querySelector('[data-id="grid-1-0"]')).not.toBe(null);
    expect(container.querySelector('[data-id="grid-1-1"]')).not.toBe(null);
    expect(container.querySelector('[data-id="grid-1-2"]')).not.toBe(null);
    // All three data rows are present and distinct.
    expect(container.querySelectorAll('.MuiDataGrid-row[data-id^="grid-1-"]').length).toBe(3);
  });
});
