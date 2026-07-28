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

  // Regression for finding 2: switching a widget's source leaves its widget-scoped filters
  // pointing at columns the new source doesn't have. The engine then reads `undefined` on every
  // row, so the widget renders EMPTY — while the drawer card looked completely normal. The row
  // must say the field is gone, and must not say it during a load race.
  describe('unresolved field (finding 2)', () => {
    const SOURCE = {
      id: 'src',
      label: 'Sales',
      fields: [{ id: 'amount', label: 'Amount', type: 'number' as const }],
      rows: [],
    };

    it('flags a filter whose field no longer exists on the widget source', () => {
      const filter = makeFilter({ field: 'total', fieldType: 'number' });
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: { filters: [filter] },
          runtime: { dataSources: { src: SOURCE } },
        },
      });
      render(
        <WidgetFilterRow
          filter={filter}
          fieldOptions={fieldOptions}
          widgetSourceId="src"
          onRemove={() => {}}
        />,
        { wrapper },
      );

      expect(screen.getByTestId('filter-field-unresolved')).not.toBe(null);
      expect(screen.getByText('total (unavailable)')).not.toBe(null);
    });

    it('clears the field so the row falls back to its picker when the user re-points it', async () => {
      const filter = makeFilter({ field: 'total', fieldType: 'number' });
      const { controller, wrapper } = createStudioHarness({
        initialState: {
          doc: { filters: [filter] },
          runtime: { dataSources: { src: SOURCE } },
        },
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

      await user.click(screen.getByRole('button', { name: 'Select a field…' }));
      // M7: the repoint clears the whole condition, not just the field triple — a second
      // condition authored against the old field must not survive into the new one.
      expect(updateSpy).toHaveBeenCalledWith('wf1', {
        field: '',
        fieldType: undefined,
        filterSourceId: undefined,
        operator: 'equals',
        value: '',
        operator2: undefined,
        value2: undefined,
        conjunction: undefined,
      });
    });

    it('stays silent while the data sources have not been injected yet', () => {
      const filter = makeFilter({ field: 'total', fieldType: 'number' });
      const { wrapper } = createStudioHarness({ initialState: { doc: { filters: [filter] } } });
      render(
        <WidgetFilterRow
          filter={filter}
          fieldOptions={fieldOptions}
          widgetSourceId="src"
          onRemove={() => {}}
        />,
        { wrapper },
      );

      expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
    });

    it('stays silent for a resolvable field', () => {
      const filter = makeFilter();
      const { wrapper } = createStudioHarness({
        initialState: {
          doc: { filters: [filter] },
          runtime: { dataSources: { src: SOURCE } },
        },
      });
      render(
        <WidgetFilterRow
          filter={filter}
          fieldOptions={fieldOptions}
          widgetSourceId="src"
          onRemove={() => {}}
        />,
        { wrapper },
      );

      expect(screen.queryByTestId('filter-field-unresolved')).toBe(null);
    });
  });

  // Wave 1 made `StudioController.updateFilter` return a `StudioMutationResult` instead of
  // `void`. This row ignored it, so a refusal was indistinguishable from a save.
  describe('rejected mutations (wave 1 handoff)', () => {
    it('reports a rejected change instead of silently discarding it', async () => {
      const filter = makeFilter();
      const { controller, wrapper } = createStudioHarness({
        initialState: { doc: { filters: [filter] } },
      });
      vi.spyOn(controller, 'updateFilter').mockReturnValue({
        ok: false,
        reason: 'rank-conflict',
      });
      const { user } = render(
        <WidgetFilterRow
          filter={filter}
          fieldOptions={fieldOptions}
          widgetSourceId="src"
          onRemove={() => {}}
        />,
        { wrapper },
      );

      await user.click(screen.getAllByRole('combobox')[0]);
      await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[1]);

      expect(screen.getByTestId('widget-filter-change-error')).not.toBe(null);
    });

    it('shows no error for an accepted change', async () => {
      const filter = makeFilter();
      const { wrapper } = createStudioHarness({
        initialState: { doc: { filters: [filter] } },
      });
      const { user } = render(
        <WidgetFilterRow
          filter={filter}
          fieldOptions={fieldOptions}
          widgetSourceId="src"
          onRemove={() => {}}
        />,
        { wrapper },
      );

      await user.click(screen.getAllByRole('combobox')[0]);
      await user.click(within(screen.getByRole('listbox')).getAllByRole('option')[1]);

      expect(screen.queryByTestId('widget-filter-change-error')).toBe(null);
    });
  });
});
