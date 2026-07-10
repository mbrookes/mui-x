import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioFilterState } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { WidgetFilterRow } from './WidgetFilterRow';
import type { FieldOption } from './filterDrawerTypes';

const { render } = createRenderer();

const fieldOptions: FieldOption[] = [
  { id: 'amount', label: 'Amount', fieldType: 'number', sourceId: 'src', sourceLabel: 'Sales' },
];

function makeFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'wf1',
    field: 'amount',
    fieldType: 'number',
    operator: 'equals',
    value: '',
    scope: { kind: 'widget', widgetId: 'w1' },
    ...overrides,
  };
}

describe('WidgetFilterRow', () => {
  // Regression for finding 1.4: `handleFilterChange` used to spread the render-time `filter`
  // snapshot (`{ ...filter, ...changes }`) and commit the WHOLE merged object.
  // `controller.updateFilter` already merges the patch into the CURRENT store filter, so
  // passing the full snapshot re-writes every field with stale values — a debounced value
  // commit landing after a concurrent operator edit would revert the operator change. The fix
  // commits ONLY the delta.
  it('commits only the changed fields to controller.updateFilter, not the whole filter snapshot (1.4)', async () => {
    const filter = makeFilter();
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    const { user } = render(
      <WidgetFilterRow
        filter={filter}
        fieldOptions={fieldOptions}
        widgetSourceId="src"
        onRemove={() => {}}
      />,
      { wrapper },
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(updateSpy).toHaveBeenCalledWith('wf1', { operator: 'greater_than' });
    // The stale `value`/`field` from the render-time snapshot must NOT be present in the
    // commit — only the changed key.
    const [, committedChanges] = updateSpy.mock.calls[0];
    expect(committedChanges).not.toHaveProperty('value');
    expect(committedChanges).not.toHaveProperty('field');
  });

  // Regression for finding 2.12 (display/doc drift half): `activeOperator` is a DISPLAY-ONLY
  // fallback (`operators.find(...) ? filter.operator : operators[0].value`) — previously the
  // row rendered the fallback but never wrote it back, so the doc kept an invalid stored
  // operator (e.g. `contains` on a `number` field) that the engine kept applying. The row must
  // self-repair the doc, non-undoably, to match what it displays.
  it('repairs an invalid stored operator back to the doc as a non-undoable write (2.12)', async () => {
    const filter = makeFilter({ operator: 'contains' as StudioFilterState['operator'] });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <WidgetFilterRow
        filter={filter}
        fieldOptions={fieldOptions}
        widgetSourceId="src"
        onRemove={() => {}}
      />,
      { wrapper },
    );

    expect(updateSpy).toHaveBeenCalledWith('wf1', { operator: 'equals' }, { undoable: false });
  });

  // Regression for finding 2.17: gate the self-repair on a RESOLVED field type. When the field's
  // source hasn't been injected yet (a data-loading race), `fieldType` resolves to `undefined`,
  // `getOperators(undefined)` falls back to STRING_OPERATORS, and a valid stored `between`
  // operator would look "invalid" — permanently and non-undoably rewritten to `equals` purely
  // because of the race, not because the operator was ever actually wrong.
  it('does not repair a valid between operator when the field type has not resolved yet (2.17)', () => {
    const filter = makeFilter({ field: 'ship_date', fieldType: undefined, operator: 'between' });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <WidgetFilterRow
        filter={filter}
        fieldOptions={[]}
        widgetSourceId="src"
        onRemove={() => {}}
      />,
      { wrapper },
    );

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('repairs once the field type resolves to a real type that invalidates the stored operator (2.17)', () => {
    const stringFieldOptions: FieldOption[] = [
      { id: 'name', label: 'Name', fieldType: 'string', sourceId: 'src', sourceLabel: 'Sales' },
    ];
    const filter = makeFilter({ field: 'name', fieldType: undefined, operator: 'between' });
    const { controller, wrapper } = createStudioHarness({
      initialState: { doc: { filters: [filter] } },
    });
    const updateSpy = vi.spyOn(controller, 'updateFilter');
    render(
      <WidgetFilterRow
        filter={filter}
        fieldOptions={stringFieldOptions}
        widgetSourceId="src"
        onRemove={() => {}}
      />,
      { wrapper },
    );

    expect(updateSpy).toHaveBeenCalledWith('wf1', { operator: 'equals' }, { undoable: false });
  });
});
