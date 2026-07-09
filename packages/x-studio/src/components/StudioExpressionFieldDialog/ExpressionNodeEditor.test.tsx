import * as React from 'react';
import { createRenderer, screen, within } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { StudioDataField, StudioExpression } from '../../models';
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
    const { frLocaleText } = await import('../../locales/fr');
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
    const { frLocaleText } = await import('../../locales/fr');
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
    const { frLocaleText } = await import('../../locales/fr');
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
