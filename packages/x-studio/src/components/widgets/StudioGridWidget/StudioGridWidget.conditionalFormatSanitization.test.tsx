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

function makeSource(): StudioDataSource {
  return {
    id: 'src',
    label: 'Widgets',
    fields: [
      { id: 'id', label: 'ID', type: 'string' },
      { id: 'amount', label: 'Amount', type: 'number' },
    ],
    rows: [
      { id: 'r1', amount: 100 },
      { id: 'r2', amount: 1 },
    ],
  };
}

function setup(
  widgetId: string,
  style: Record<string, unknown>,
  configOverrides: Record<string, unknown> = {},
  ruleOverrides: Record<string, unknown> = {},
) {
  const source = makeSource();
  const widget: StudioWidgetOf<'grid'> = {
    id: widgetId,
    kind: 'grid',
    title: 'Grid',
    sourceId: 'src',
    config: {
      gridConditionalFormats: [
        {
          fieldId: 'amount',
          operator: 'greater_than',
          value: 50,
          style,
          ...ruleOverrides,
        },
      ],
      ...configOverrides,
    } as StudioWidgetOf<'grid'>['config'],
  };
  const initialState: CreateDefaultStudioStateOverrides = {
    doc: {
      widgets: { [widget.id]: widget },
      pages: { 'page-1': { id: 'page-1', title: 'Page 1', widgetRows: [[widget.id]] } },
    },
    runtime: { dataSources: { src: source } },
  };
  const { wrapper } = createStudioHarness({ initialState });
  return render(
    <StudioGridWidget
      widget={widget}
      dataSource={source}
      pageId="page-1"
      slotProps={{
        dataGrid: {
          disableVirtualization: true,
          columns: [
            { field: 'id', width: 100 },
            { field: 'amount', width: 100 },
          ],
        },
      }}
    />,
    { wrapper },
  );
}

/** Reads the two known cells (matching / non-matching the conditional-format rule) out of a rendered grid. */
function getCells(container: HTMLElement) {
  return {
    matchingCell: container.querySelector('[data-id="r1"] [data-field="amount"]'),
    nonMatchingCell: container.querySelector('[data-id="r2"] [data-field="amount"]'),
  };
}

/** The `amount` cell of the bottom-pinned footer summary row, if one is rendered. */
function getSummaryCell(container: HTMLElement) {
  return container.querySelector('[data-id="__summary__"] [data-field="amount"]');
}

// Finding 4: `rule.style.fontWeight` from `gridConditionalFormats` used to go into `sx`
// unchecked, while the adjacent `backgroundColor`/`color` were already sanitized.
describe('StudioGridWidget conditional-format fontWeight sanitization (finding 4)', () => {
  it('applies a valid "bold"/"normal" fontWeight', () => {
    const { container } = setup('grid-fw-valid', { fontWeight: 'bold' });
    const { matchingCell } = getCells(container);
    expect(matchingCell).not.toBe(null);
    expect(getComputedStyle(matchingCell as Element).fontWeight).toBe('700');
  });

  it('rejects an invalid fontWeight value instead of propagating it', () => {
    const { container } = setup('grid-fw-invalid', {
      fontWeight: 'bold; } .evil{background:url(https://evil/leak)',
    });
    const { matchingCell, nonMatchingCell } = getCells(container);
    expect(matchingCell).not.toBe(null);
    // Falls back to unset — same computed weight as a cell with no rule applied.
    expect(getComputedStyle(matchingCell as Element).fontWeight).toBe(
      getComputedStyle(nonMatchingCell as Element).fontWeight,
    );
    expect(document.documentElement.outerHTML).not.toContain('.evil{background:url');
  });
});

// Finding 5: `widget.id` used to be interpolated verbatim into an `sx` selector KEY
// (`` & .StudioGrid-cf-${widget.id}-${i} ``). A hostile persisted widget id containing
// CSS/selector metacharacters would inject arbitrary rules into the stylesheet the
// moment the grid has any conditional format.
describe('StudioGridWidget conditional-format widget.id selector-key sanitization (finding 5)', () => {
  it('sanitizes a widget id containing CSS-breaking characters before building the selector key', () => {
    const hostileId = 'w{}html{display:none}.x';
    const { container } = setup(hostileId, { backgroundColor: '#ff0000' });
    const { matchingCell } = getCells(container);

    // The rule still functionally applies (sanitizing the token doesn't break the feature).
    expect(matchingCell).not.toBe(null);
    expect(getComputedStyle(matchingCell as Element).backgroundColor).toBe('rgb(255, 0, 0)');

    // The raw hostile id must never appear as an actual CSS rule/selector in any stylesheet.
    const styleText = Array.from(document.styleSheets)
      .flatMap((sheet) => {
        try {
          return Array.from(sheet.cssRules).map((rule) => rule.cssText);
        } catch {
          return [];
        }
      })
      .join('\n');
    expect(styleText).not.toContain('html{display:none}');
    expect(styleText).not.toContain(hostileId);
  });
});

// ─── Conditional formats never colour the footer summary row ─────────────────
//
// `getCellClassName` short-circuits on `params.id === GRID_SUMMARY_ROW_ID`, and nothing
// asserted it. The pinned footer cell does not hold a raw aggregate — it holds the
// PRE-FORMATTED summary string ("Sum: 101"), so numeric rules can't reach it — but every
// non-numeric operator can. An `is_not_empty` rule (the "flag every populated cell" rule an
// author writes to spot gaps) matches that string and paints the footer as if it were data.
describe('StudioGridWidget conditional formats skip the footer summary row', () => {
  it('does not apply a matching rule to the pinned summary aggregate', () => {
    const { container } = setup(
      'grid-cf-summary',
      { backgroundColor: '#ff0000' },
      { gridSummaryFields: { amount: 'sum' } },
      { operator: 'is_not_empty', value: undefined },
    );

    // The rule genuinely applies to the DATA rows, so the summary assertion below cannot be
    // satisfied by conditional formatting being inert.
    const { matchingCell } = getCells(container);
    expect(matchingCell).not.toBe(null);
    expect(matchingCell!.className).toContain('StudioGrid-cf-');
    expect(getComputedStyle(matchingCell as Element).backgroundColor).toBe('rgb(255, 0, 0)');

    const summary = getSummaryCell(container);
    expect(summary).not.toBe(null);
    expect(summary!.className).not.toContain('StudioGrid-cf-');
    expect(getComputedStyle(summary as Element).backgroundColor).not.toBe('rgb(255, 0, 0)');
  });
});
