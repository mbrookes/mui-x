import * as React from 'react';
import { createRenderer, fireEvent, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import type { StudioDataField, StudioExpression, StudioFunctionExpression } from '../../models';
import { createStudioHarness } from '../../internals/test-utils';
import { ExpressionBuilder } from './ExpressionNodeEditor';

const { render } = createRenderer();

const SOURCE_FIELDS: StudioDataField[] = [{ id: 'amount', label: 'Amount', type: 'number' }];

// Regression coverage for architecture-review finding 2.2: the operator picker,
// aggregation picker, and the "Condition"/"Then"/"Else"/"Unit"/"Input N"/"Add input"
// labels used to be hardcoded English, bypassing `useStudioLocaleText` even though the
// dialog already resolves every other string through it.
describe('<ExpressionBuilder /> localization', () => {
  it('renders operator options, the aggregation picker, and generic input labels translated under a non-English locale', async () => {
    const { frLocaleText } = await import('@mui/x-studio-core/locales');
    const expression: StudioExpression = {
      operator: 'add',
      inputs: [{ id: 'amount' }, { type: 'number', value: 0 }, { type: 'number', value: 0 }],
    } as StudioExpression;

    const { wrapper } = createStudioHarness({ providerProps: { localeText: frLocaleText } });
    const { user } = render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure
        onChange={() => {}}
      />,
      { wrapper },
    );

    // The selected operator ("add") shows its French label, not the English default.
    expect(screen.getByText('Additionner (+)')).toBeVisible();
    expect(screen.queryByText('Add (+)')).toBeNull();

    // Opening the operator dropdown reveals the translated group headings too.
    const operatorSelect = screen
      .getAllByRole('combobox')
      .find((el) => /Additionner/.test(el.textContent ?? ''));
    expect(operatorSelect).toBeDefined();
    await user.click(operatorSelect!);
    const listbox = screen.getByRole('listbox');
    expect(within(listbox).getByRole('option', { name: /Additionner/ })).toBeVisible();
    expect(within(listbox).getAllByText('Arithmétique').length).toBeGreaterThan(0);
    expect(within(listbox).queryByText('Arithmetic')).toBeNull();
    await user.keyboard('{Escape}');

    // The aggregation picker (shown for a measure field input) is translated via the
    // shared `aggFn*` tokens instead of a duplicate hardcoded "Sum".
    expect(screen.getByText('Somme')).toBeVisible();
    expect(screen.queryByText('Sum')).toBeNull();

    // The 2nd/3rd generic inputs (not "if"'s Condition/Then/Else) are labeled via the
    // translated `exprInputLabelGeneric` template, not a hardcoded "Input N".
    expect(screen.getByText('Entrée 2')).toBeVisible();
    expect(screen.getByText('Entrée 3')).toBeVisible();
    expect(screen.queryByText('Input 2')).toBeNull();
    expect(screen.queryByText('Input 3')).toBeNull();

    // The "Add input" button is translated.
    expect(screen.getByRole('button', { name: 'Ajouter une entrée' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add input' })).toBeNull();
  });

  it('renders the "if" operator\'s Condition/Then/Else input labels translated', async () => {
    const { frLocaleText } = await import('@mui/x-studio-core/locales');
    const expression: StudioExpression = {
      operator: 'if',
      inputs: [
        { type: 'boolean', value: true },
        { type: 'number', value: 1 },
        { type: 'number', value: 0 },
      ],
    } as StudioExpression;

    const { wrapper } = createStudioHarness({ providerProps: { localeText: frLocaleText } });
    render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByText('Condition')).toBeVisible();
    expect(screen.getByText('Alors')).toBeVisible();
    expect(screen.getByText('Sinon')).toBeVisible();
    expect(screen.queryByText('Then')).toBeNull();
    expect(screen.queryByText('Else')).toBeNull();
  });

  it('renders the "datediff" operator\'s unit input label translated', async () => {
    const { frLocaleText } = await import('@mui/x-studio-core/locales');
    const expression: StudioExpression = {
      operator: 'datediff',
      inputs: [
        { type: 'string', value: 'day' },
        { type: 'number', value: 0 },
        { type: 'number', value: 0 },
      ],
    } as StudioExpression;

    const { wrapper } = createStudioHarness({ providerProps: { localeText: frLocaleText } });
    render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );

    expect(screen.getByText('Unité (par exemple "jour", "mois", "année")')).toBeVisible();
    expect(screen.queryByText('Unit (e.g. "day", "month", "year")')).toBeNull();
  });
});

// Regression coverage for architecture-review finding 1.14: a `type="number"` input
// reports `badInput` (and an empty `event.target.value`) while the user is still
// typing a bare "-" or a trailing ".", which used to be coerced straight to a
// committed `0` on every keystroke. The literal-number input now buffers the
// displayed text locally and only parses/commits on blur.
describe('<ExpressionBuilder /> numeric literal input (finding 1.14)', () => {
  function renderNegateLiteral(initialValue: number) {
    const expression: StudioExpression = {
      operator: 'negate',
      inputs: [{ type: 'number', value: initialValue }],
    } as StudioExpression;
    const onChange = vi.fn();
    const { wrapper } = createStudioHarness();
    const { user } = render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={onChange}
      />,
      { wrapper },
    );
    return { onChange, user };
  }

  // Real keystroke-by-keystroke typing (not a single `fireEvent.change`) is used
  // so a decimal point/minus sign is typed as an actual intermediate keystroke.
  // With the old per-keystroke-commit code, the intermediate "10." keystroke
  // re-derived the controlled value from `Number('10.')` → `10`, which forced the
  // field back to "10" and corrupted every keystroke typed after it (e.g. typing
  // "10.5" would land on "105", not "10.5"). Asserting the FINAL text after typing
  // the whole sequence therefore still exercises the exact regression, even though
  // this jsdom's `type="number"` sanitizes a truly incomplete value (a lone "-" or
  // trailing ".") down to "" if read mid-keystroke.
  it('preserves a trailing decimal point typed mid-sequence', async () => {
    const { user } = renderNegateLiteral(10);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '10.5');
    expect(input.value).toBe('10.5');
  });

  it('does not commit on every keystroke, only on blur', async () => {
    const { onChange, user } = renderNegateLiteral(10);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '10.5');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0][0] as StudioFunctionExpression;
    expect(committed.inputs[0]).toMatchObject({ type: 'number', value: 10.5 });
  });

  it('preserves a negative sign typed mid-sequence and commits it on blur', async () => {
    const { onChange, user } = renderNegateLiteral(10);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '-5');
    expect(input.value).toBe('-5');
    fireEvent.blur(input);
    const committed = onChange.mock.calls[0][0] as StudioFunctionExpression;
    expect(committed.inputs[0]).toMatchObject({ type: 'number', value: -5 });
  });

  it('allows clearing the field while typing without it reverting mid-edit', async () => {
    const { user } = renderNegateLiteral(10);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    expect(input.value).toBe('');
  });

  it('reverts to the last committed value when blurred empty', async () => {
    const { onChange, user } = renderNegateLiteral(10);
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    await user.clear(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('10');
  });
});

/**
 * The operator arity tables are plain object literals keyed by a doc/AI-authored
 * `operator`. A bare `MIN_INPUTS[operator]` on `"constructor"` resolves the inherited
 * `Object` constructor: `??` never fires, `inputs.length > minInputs` is false (no remove
 * buttons) and `inputs.length < maxInputs` is false (no add button) — the operand list
 * becomes completely uneditable. Guarded via `utils/safeLookup`'s `lookup`.
 */
describe('<ExpressionBuilder /> prototype-chain operator', () => {
  function renderWithOperator(operator: string) {
    const expression = {
      operator,
      inputs: [
        { type: 'number', value: 1 },
        { type: 'number', value: 2 },
      ],
    } as unknown as StudioExpression;
    const { wrapper } = createStudioHarness();
    return render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );
  }

  it('keeps the operand list editable for an Object.prototype-named operator', () => {
    renderWithOperator('constructor');
    // Add button present (no max arity resolved) …
    expect(screen.getByRole('button', { name: 'Add input' })).not.toBe(null);
    // … and one remove button per operand (min arity falls back to 1).
    expect(screen.getAllByRole('button', { name: 'Remove input' })).toHaveLength(2);
  });

  it('keeps the operand list editable for a "toString" operator', () => {
    renderWithOperator('toString');
    expect(screen.getByRole('button', { name: 'Add input' })).not.toBe(null);
    expect(screen.getAllByRole('button', { name: 'Remove input' })).toHaveLength(2);
  });
});

/**
 * The literal editor is a pair of controls: a type `Select` and a value input. Only the
 * Select carried an accessible name, so a screen-reader user reached an unlabeled edit box
 * for the value half.
 */
describe('<ExpressionBuilder /> literal value accessible name', () => {
  function renderLiteral(
    literal: StudioExpression,
    harnessOptions?: Parameters<typeof createStudioHarness>[0],
  ) {
    const expression = { operator: 'negate', inputs: [literal] } as unknown as StudioExpression;
    const { wrapper } = createStudioHarness(harnessOptions);
    return render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );
  }

  it('names the numeric literal input', () => {
    renderLiteral({ type: 'number', value: 3 } as StudioExpression);
    expect(screen.getByRole('spinbutton', { name: 'Literal value' })).not.toBe(null);
  });

  it('names the string literal input', () => {
    renderLiteral({ type: 'string', value: 'abc' } as StudioExpression);
    expect(screen.getByRole('textbox', { name: 'Literal value' })).not.toBe(null);
  });

  it('translates the name under a non-English locale', async () => {
    const { frLocaleText } = await import('@mui/x-studio-core/locales');
    renderLiteral({ type: 'number', value: 3 } as StudioExpression, {
      providerProps: { localeText: frLocaleText },
    });
    expect(screen.getByRole('spinbutton', { name: 'Valeur littérale' })).not.toBe(null);
  });
});

/**
 * A root expression that isn't a function node — a bare field reference or literal, both of
 * which a persisted or AI-authored field can carry — used to be rendered as an `add` node
 * with zero operands: the real definition appeared nowhere, and one click on "Add input"
 * replaced it with that fabrication.
 */
describe('<ExpressionBuilder /> non-function root', () => {
  function renderRoot(expression: StudioExpression, onChange = () => {}) {
    const { wrapper } = createStudioHarness();
    return render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={onChange}
      />,
      { wrapper },
    );
  }

  it('shows a bare field-reference root as a field operand, not a fabricated add node', () => {
    renderRoot({ id: 'amount' } as StudioExpression);

    const fieldSelect = screen.getByRole('combobox', { name: 'Field' });
    expect(fieldSelect.textContent).toContain('Amount');
    // No operator picker claiming the expression is an `add` …
    expect(screen.queryByText('Add (+)')).toBeNull();
    // … and therefore no "Add input" button that would overwrite the root.
    expect(screen.queryByRole('button', { name: 'Add input' })).toBeNull();
  });

  it('shows a bare literal root as a literal operand', () => {
    renderRoot({ type: 'number', value: 42 } as StudioExpression);

    expect(screen.getByRole('spinbutton', { name: 'Literal value' })).toHaveProperty('value', '42');
    expect(screen.queryByRole('button', { name: 'Add input' })).toBeNull();
  });

  it('converts the root to a function node only when the user asks for one', async () => {
    const onChange = vi.fn();
    const { user } = renderRoot({ id: 'amount' } as StudioExpression, onChange);

    await user.click(screen.getByRole('combobox', { name: 'Input type' }));
    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: 'Function' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({ operator: 'add' });
  });
});

/**
 * Selecting "Field" with nothing to reference used to emit a *literal*, so the kind Select
 * snapped straight back to "Literal" with no explanation.
 */
describe('<ExpressionBuilder /> input kind with no field options', () => {
  it('disables the Field option when the source has no referenceable fields', async () => {
    const expression = {
      operator: 'negate',
      inputs: [{ type: 'number', value: 0 }],
    } as unknown as StudioExpression;
    const { wrapper } = createStudioHarness();
    const { user } = render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={[]}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole('combobox', { name: 'Input type' }));
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: 'Field' });
    expect(option.getAttribute('aria-disabled')).toBe('true');
  });

  it('keeps the Field option enabled when the source has fields', async () => {
    const expression = {
      operator: 'negate',
      inputs: [{ type: 'number', value: 0 }],
    } as unknown as StudioExpression;
    const { wrapper } = createStudioHarness();
    const { user } = render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );

    await user.click(screen.getByRole('combobox', { name: 'Input type' }));
    const option = within(screen.getByRole('listbox')).getByRole('option', { name: 'Field' });
    expect(option.getAttribute('aria-disabled')).toBe(null);
  });
});

/**
 * A field referenced by an expression can be dropped from its data source. Without a
 * matching `MenuItem` the `Select` value is out of range: MUI logs a warning and the
 * control renders blank, hiding the fact that the stale id is still stored.
 */
describe('<ExpressionBuilder /> dropped field reference', () => {
  it('surfaces the stale field id instead of rendering a blank Select', () => {
    const expression = {
      operator: 'add',
      inputs: [{ id: 'removed_field' }, { id: 'amount' }],
    } as unknown as StudioExpression;
    const { wrapper } = createStudioHarness();
    render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={false}
        onChange={() => {}}
      />,
      { wrapper },
    );
    expect(screen.getByText('removed_field')).toBeVisible();
  });
});

// None of the five operand-row `Select`s has an `InputLabel` to take a name from, so each
// relies on an explicit `aria-label`. Two spellings reach the rendered `role="combobox"`
// element in @mui/material v9 — a bare `aria-label` prop (which `InputBase` destructures and
// forwards to the inner input, see `InputBase.js`) and `inputProps['aria-label']` (which
// `Select` merges into the same place). These tests assert the OUTCOME — a named combobox —
// rather than which spelling produced it, so they hold across either. Without them, a review
// pass that "fixes" one spelling into the other has nothing pinning that the name still lands
// on the combobox and not on the `InputBase` wrapper `<div>`.
describe('<ExpressionBuilder /> combobox accessible names', () => {
  function renderExpr(expression: StudioExpression, isMeasure = false) {
    const { wrapper } = createStudioHarness();
    return render(
      <ExpressionBuilder
        expression={expression}
        sourceFields={SOURCE_FIELDS}
        expressionFields={[]}
        isMeasure={isMeasure}
        onChange={() => {}}
      />,
      { wrapper },
    );
  }

  it('names the operand kind and field pickers', () => {
    renderExpr({ operator: 'negate', inputs: [{ id: 'amount' }] } as unknown as StudioExpression);
    expect(screen.getByRole('combobox', { name: 'Input type' })).not.toBe(null);
    expect(screen.getByRole('combobox', { name: 'Field' })).not.toBe(null);
  });

  it('names the aggregation picker on a measure field operand', () => {
    renderExpr(
      { operator: 'negate', inputs: [{ id: 'amount' }] } as unknown as StudioExpression,
      true,
    );
    expect(screen.getByRole('combobox', { name: 'Aggregation' })).not.toBe(null);
  });

  it('names the literal type picker', () => {
    renderExpr({
      operator: 'negate',
      inputs: [{ type: 'string', value: 'abc' }],
    } as unknown as StudioExpression);
    expect(screen.getByRole('combobox', { name: 'Literal type' })).not.toBe(null);
  });

  it('names the boolean literal value picker', () => {
    renderExpr({
      operator: 'negate',
      inputs: [{ type: 'boolean', value: true }],
    } as unknown as StudioExpression);
    expect(screen.getByRole('combobox', { name: 'Boolean value' })).not.toBe(null);
  });
});
