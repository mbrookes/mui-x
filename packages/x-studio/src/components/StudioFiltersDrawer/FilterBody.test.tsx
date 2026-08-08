import * as React from 'react';
import { createRenderer, fireEvent, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { getOperators } from '@mui/x-studio-core/engine';
import type { StudioFilterState } from '../../models';
import { FilterBody } from './FilterBody';

const { render } = createRenderer();

function makeFilter(overrides: Partial<StudioFilterState> = {}): StudioFilterState {
  return {
    id: 'f1',
    field: 'amount',
    fieldType: 'number',
    operator: 'between',
    value: { from: 10, to: 20 },
    scope: { kind: 'page' },
    ...overrides,
  };
}

describe('FilterBody', () => {
  // Regression for finding 1.6: switching a filter's operator AWAY from `between` used to
  // write only `{ operator: newOperator }`, leaving the stale `{ from, to }` object value in
  // place. `toComparable` then produces NaN for that object, so e.g. `greater_than` silently
  // matches nothing, and the value input renders "[object Object]". The operator `onChange`
  // must reset the value when the new operator is shape-incompatible with the object.
  it('resets an object `between` value when the operator switches away from `between` (1.6)', async () => {
    const filter = makeFilter();
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="between"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(onChange).toHaveBeenCalledWith({ operator: 'greater_than', value: '' });
  });

  it('does not reset the value when switching between two non-between operators', async () => {
    const filter = makeFilter({ operator: 'equals', value: '5' });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(onChange).toHaveBeenCalledWith({ operator: 'greater_than' });
  });

  // Regression for finding 1.14: a `RelativeDateValue` (`{ relative: true, amount, unit,
  // direction }`) is a non-array object but a fully-supported scalar date value, NOT a
  // `between`-shaped one. The reset predicate used to also fire for it, so switching a
  // relative-date filter's operator (e.g. "On" → "Before") silently discarded the configured
  // relative value.
  it('does NOT reset a RelativeDateValue when the operator switches between scalar date operators (1.14)', async () => {
    const filter = makeFilter({
      fieldType: 'date',
      operator: 'equals',
      value: { relative: true, amount: 7, unit: 'day', direction: 'past' },
    });
    const onChange = vi.fn();
    const operators = getOperators('date');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="date"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('Before'));

    // Only the operator changes — the relative value is preserved (no `value` key).
    expect(onChange).toHaveBeenCalledWith({ operator: 'less_than' });
  });

  // Regression for finding 1.15: the SECOND condition's `operator2` handler had neither the
  // between-shape reset nor the relative-date exclusion the primary `operator` has. Switching
  // `operator2` away from `between` used to leave the `{ from, to }` object in `value2`,
  // which evaluates as NaN (matches nothing) and renders "[object Object]".
  it('resets an object `between` value2 when operator2 switches away from `between` (1.15)', async () => {
    const filter = makeFilter({
      operator: 'equals',
      value: '5',
      operator2: 'between',
      value2: { from: 1, to: 2 },
      conjunction: 'and',
    });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="between"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    // combobox[0] is the primary operator; combobox[1] is operator2.
    const operator2Select = screen.getAllByRole('combobox')[1];
    await user.click(operator2Select);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('='));

    expect(onChange).toHaveBeenCalledWith({ operator2: 'equals', value2: '' });
  });

  it('does NOT reset value2 when operator2 switches between two non-between operators (1.15)', async () => {
    const filter = makeFilter({
      operator: 'equals',
      value: '5',
      operator2: 'equals',
      value2: '7',
      conjunction: 'and',
    });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operator2Select = screen.getAllByRole('combobox')[1];
    await user.click(operator2Select);
    const listbox = screen.getByRole('listbox');
    await user.click(within(listbox).getByText('>'));

    expect(onChange).toHaveBeenCalledWith({ operator2: 'greater_than' });
  });

  // M8: the reset ran in ONE direction only. ARCHITECTURE.md has always claimed "in both
  // directions", and the missing half left `revenue = 500` rendering two EMPTY bound inputs
  // over a stored scalar `500` — a card the user reads as a half-authored range they never
  // cleared, and whose first typed bound silently replaces the old value.
  it('resets a scalar value when the operator switches TO `between` (M8)', async () => {
    const filter = makeFilter({ operator: 'equals', value: 500 });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));

    expect(onChange).toHaveBeenCalledWith({ operator: 'between', value: '' });
  });

  it('resets a scalar value2 when operator2 switches TO `between` (M8)', async () => {
    const filter = makeFilter({
      operator: 'equals',
      value: '5',
      operator2: 'equals',
      value2: '7',
      conjunction: 'and',
    });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operator2Select = screen.getAllByRole('combobox')[1];
    await user.click(operator2Select);
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));

    expect(onChange).toHaveBeenCalledWith({ operator2: 'between', value2: '' });
  });

  it('does not reset an ALREADY-EMPTY value when switching to `between` (M8)', async () => {
    const filter = makeFilter({ operator: 'equals', value: '' });
    const onChange = vi.fn();
    const operators = getOperators('number');
    const { user } = render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));

    // Nothing to strand, so no redundant `value` key in the delta.
    expect(onChange).toHaveBeenCalledWith({ operator: 'between' });
  });

  // M9, end to end. The old sequence: "On: 3 months ago" → Between (no reset, M8) → pick a
  // `from` → `FilterValueInput` spread the relative value as the between base, producing
  // `{ relative: true, amount: 3, unit: 'month', direction: 'past', from }`. The loose
  // `isRelativeDateValue` then answered `true` for that hybrid, so every `between` ↔ scalar
  // reset guard refused to fire ever again and the widget-edit dialog rendered it read-only:
  // the user's typed range was unreachable. With M8 the first step already resets, and the
  // hardened predicate means even a host/AI-authored hybrid stays repairable.
  it('leaves a relative-date filter repairable across a Between round-trip (M9)', async () => {
    const relative = { relative: true, amount: 3, unit: 'month', direction: 'past' } as const;
    const operators = getOperators('date');

    // Step 1 — "On: 3 months ago" → "Between" now clears the scalar relative value.
    const onChange = vi.fn();
    const { user, unmount } = render(
      <FilterBody
        filter={makeFilter({ fieldType: 'date', operator: 'equals', value: relative })}
        fieldType="date"
        operators={operators}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );
    const operatorSelect = screen.getAllByRole('combobox')[0];
    await user.click(operatorSelect);
    await user.click(within(screen.getByRole('listbox')).getByText('Between'));
    expect(onChange).toHaveBeenCalledWith({ operator: 'between', value: '' });
    unmount();

    // Step 2 — even a doc that already holds the hybrid (host- or AI-authored) is repairable:
    // switching back to a scalar operator resets it instead of silently keeping it.
    const hybrid = { ...relative, from: '2024-01-01' };
    const onChange2 = vi.fn();
    const { user: user2 } = render(
      <LocalizationProvider dateAdapter={AdapterDayjs}>
        <FilterBody
          filter={makeFilter({ fieldType: 'date', operator: 'between', value: hybrid })}
          fieldType="date"
          operators={operators}
          activeOperator="between"
          activeOperator2="equals"
          fieldValues={[]}
          onModeChange={() => {}}
          onChange={onChange2}
        />
      </LocalizationProvider>,
    );
    await user2.click(screen.getAllByRole('combobox')[0]);
    await user2.click(within(screen.getByRole('listbox')).getByText('Before'));
    expect(onChange2).toHaveBeenCalledWith({ operator: 'less_than', value: '' });
  });

  // L17: a selection-mode filter's `operator` decides whether the checked values are included
  // or excluded, and `not_in` is reachable here without `StudioFilterWidget` (host
  // `initialState`, persisted docs, the wire `addFilter` mutation, `controller.addFilter` /
  // `updateFilter`, and `applyFilterPreset`). The selection editor previously never read or
  // wrote it, so the card's own summary said "is not: …" over a UI that looked like an
  // include list.
  it('surfaces a `not_in` selection filter as excluding (L17)', () => {
    render(
      <FilterBody
        filter={makeFilter({
          fieldType: 'string',
          filterMode: 'selection',
          operator: 'not_in',
          value: ['DE'],
        })}
        fieldType="string"
        operators={getOperators('string')}
        activeOperator="not_in"
        activeOperator2="equals"
        fieldValues={['DE', 'FR']}
        onModeChange={() => {}}
        onChange={vi.fn()}
      />,
    );

    const toggle = screen.getByRole('switch', { name: /Excluding selected/ }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it('writes the operator back when exclusion is toggled in selection mode (L17)', () => {
    const onChange = vi.fn();
    render(
      <FilterBody
        filter={makeFilter({
          fieldType: 'string',
          filterMode: 'selection',
          // `buildModeReset` leaves `operator` untouched on a condition → selection switch, so
          // a leftover `equals` is the ordinary case; toggling must normalize it.
          operator: 'equals',
          value: ['DE'],
        })}
        fieldType="string"
        operators={getOperators('string')}
        activeOperator="equals"
        activeOperator2="equals"
        fieldValues={['DE', 'FR']}
        onModeChange={() => {}}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('switch', { name: 'Exclude selected' }));
    expect(onChange).toHaveBeenCalledWith({ operator: 'not_in' });
  });
});

/**
 * The incomplete-filter warning (AG_STUDIO_GAP_ANALYSIS XS-EDIT-002).
 *
 * A condition-mode filter with a blank value is DROPPED by the engine (`isFilterComplete`), so it
 * sits in the drawer looking configured while filtering nothing — the card summarises as if it
 * were live and the section's count badge includes it. The silence is the bug; the only way to
 * discover it was to notice the rows never changed.
 */
describe('FilterBody — incomplete condition warning', () => {
  function renderBody(filter: StudioFilterState) {
    return render(
      <FilterBody
        filter={filter}
        fieldType="number"
        operators={getOperators('number')}
        activeOperator={filter.operator}
        activeOperator2="equals"
        fieldValues={[]}
        onModeChange={() => {}}
        onChange={() => {}}
      />,
    );
  }

  it('warns when a condition has no value', () => {
    renderBody(makeFilter({ operator: 'equals', value: '' }));
    expect(screen.getByRole('status')).to.not.equal(null);
  });

  it('is silent once the condition has a value', () => {
    renderBody(makeFilter({ operator: 'equals', value: '5' }));
    expect(screen.queryByRole('status')).to.equal(null);
  });

  it('uses status rather than alert', () => {
    // This appears and disappears as the user types. An assertive `role="alert"` would interrupt
    // them on every keystroke that empties the field; `status` is polite and is read at the next
    // pause, which is when the information is wanted.
    renderBody(makeFilter({ operator: 'equals', value: '' }));
    expect(screen.queryByRole('alert')).to.equal(null);
    expect(screen.getByRole('status')).to.not.equal(null);
  });

  it('says what the consequence is, not that a field is required', () => {
    // "Required" describes a form rule. The user cannot see the engine's behaviour, and that is
    // the thing worth telling them: the filter exists and is not being applied.
    renderBody(makeFilter({ operator: 'equals', value: '' }));
    expect(screen.getByRole('status').textContent).to.contain('not being applied');
  });

  it('does not warn in selection mode, where an empty value means "any"', () => {
    // An empty SELECTION is a real, intentional state — it matches everything — so warning about
    // it would be false. Only a condition-mode blank is inert.
    renderBody(makeFilter({ filterMode: 'selection', operator: 'in', value: [] }));
    expect(screen.queryByRole('status')).to.equal(null);
  });
});
