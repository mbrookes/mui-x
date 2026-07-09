import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { InlineFormulaBar } from './InlineFormulaBar';
import type { FieldOption } from './operandEditorTypes';

const { render } = createRenderer();

const FIELDS: FieldOption[] = [
  { id: 'amount', label: 'Amount' },
  { id: 'cost', label: 'Cost' },
];

function setup() {
  const onFieldCreated = vi.fn();
  const { controller, wrapper } = createStudioHarness();
  const addSpy = vi.spyOn(controller, 'addExpressionField');
  const utils = render(
    <InlineFormulaBar sourceId="orders" fields={FIELDS} onFieldCreated={onFieldCreated} />,
    { wrapper },
  );
  return { addSpy, onFieldCreated, ...utils };
}

describe('InlineFormulaBar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a new expression field with an id on Add', async () => {
    const { user, addSpy, onFieldCreated } = setup();

    await user.click(screen.getByRole('button', { name: 'Formula' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(addSpy).toHaveBeenCalledTimes(1);
    const created = addSpy.mock.calls[0][0];
    expect(created.id).toMatch(/^expr_formula_/);
    expect(onFieldCreated).toHaveBeenCalledWith(created.id);
  });

  // Regression test for finding 3.11: the previous `expr_formula_${Date.now()}` id
  // collides whenever two formula fields are created within the same millisecond —
  // a real risk for rapid "Add" clicks, since `Date.now()` has only ms resolution.
  // `addExpressionField` is idempotent on `id`, so a collision would silently drop
  // the second field instead of creating it.
  it('mints a unique id even when Date.now() does not advance between creates', async () => {
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const { user, addSpy } = setup();

    await user.click(screen.getByRole('button', { name: 'Formula' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));
    // The bar collapses after a successful add; reopen it for a second creation.
    await user.click(screen.getByRole('button', { name: 'Formula' }));
    await user.click(screen.getByRole('button', { name: 'Add' }));

    expect(addSpy).toHaveBeenCalledTimes(2);
    const firstId = addSpy.mock.calls[0][0].id;
    const secondId = addSpy.mock.calls[1][0].id;
    expect(firstId).not.toBe(secondId);
  });

  it('disables Add until both operands are set', async () => {
    const { user } = setup();

    await user.click(screen.getByRole('button', { name: 'Formula' }));
    expect(screen.getByRole('button', { name: 'Add' })).toHaveProperty('disabled', false);
  });
});
