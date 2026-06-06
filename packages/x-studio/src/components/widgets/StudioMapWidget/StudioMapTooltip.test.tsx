import * as React from 'react';
import { describe, expect, it } from 'vitest';
import { createRenderer } from '@mui/internal-test-utils';
import { StudioMapTooltipContext } from './StudioMapTooltip';

const { render } = createRenderer();

// ─── Context default values ───────────────────────────────────────────────────

describe('StudioMapTooltipContext defaults', () => {
  it('provides a featureIdToLabel that returns the raw featureId', () => {
    let captured: ((id: string) => string) | null = null;
    function Probe() {
      const ctx = React.useContext(StudioMapTooltipContext);
      captured = ctx.featureIdToLabel;
      return null;
    }
    render(<Probe />);
    expect(captured).not.toBeNull();
    expect(captured!('US')).toBe('US');
    expect(captured!('unknown-id')).toBe('unknown-id');
  });

  it('has a null valueFieldLabel by default', () => {
    let label: string | null = 'not-set';
    function Probe() {
      const ctx = React.useContext(StudioMapTooltipContext);
      label = ctx.valueFieldLabel;
      return null;
    }
    render(<Probe />);
    expect(label).toBeNull();
  });
});

// ─── Context provider plumbing ────────────────────────────────────────────────

describe('StudioMapTooltipContext provider', () => {
  it('passes featureIdToLabel and valueFieldLabel to consumers', () => {
    const resolveLabel = (id: string) => (id === 'FR' ? 'France' : id);
    let captured: { valueFieldLabel: string | null; regionName: string } = {
      valueFieldLabel: null,
      regionName: '',
    };

    function Probe() {
      const ctx = React.useContext(StudioMapTooltipContext);
      captured = {
        valueFieldLabel: ctx.valueFieldLabel,
        regionName: ctx.featureIdToLabel('FR'),
      };
      return null;
    }

    render(
      <StudioMapTooltipContext.Provider
        value={{ valueFieldLabel: 'Net Sales', featureIdToLabel: resolveLabel }}
      >
        <Probe />
      </StudioMapTooltipContext.Provider>,
    );

    expect(captured.valueFieldLabel).toBe('Net Sales');
    expect(captured.regionName).toBe('France');
  });

  it('resolves unknown featureId to raw id when no mapping exists', () => {
    const resolveLabel = (id: string) => (id === 'FR' ? 'France' : id);
    let regionName = '';

    function Probe() {
      const ctx = React.useContext(StudioMapTooltipContext);
      regionName = ctx.featureIdToLabel('ZZ');
      return null;
    }

    render(
      <StudioMapTooltipContext.Provider
        value={{ valueFieldLabel: null, featureIdToLabel: resolveLabel }}
      >
        <Probe />
      </StudioMapTooltipContext.Provider>,
    );

    expect(regionName).toBe('ZZ');
  });
});

// ─── valueFieldLabel derivation logic ────────────────────────────────────────

/**
 * Replicates the derivation logic from StudioMapWidget to unit-test it in isolation.
 * If the declared field label is present, prefer it; otherwise transform the field ID.
 */
function deriveValueFieldLabel(
  valueField: string | undefined,
  fields: Array<{ id: string; label: string }>,
): string | null {
  if (!valueField) return null;
  const declared = fields.find((f) => f.id === valueField)?.label;
  if (declared) return declared;
  return valueField
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

describe('valueFieldLabel derivation', () => {
  it('returns null when valueField is undefined', () => {
    expect(deriveValueFieldLabel(undefined, [])).toBeNull();
  });

  it('uses declared field label when present', () => {
    const fields = [{ id: 'net_sales', label: 'Net Sales' }];
    expect(deriveValueFieldLabel('net_sales', fields)).toBe('Net Sales');
  });

  it('falls back to string-transform when no field matches', () => {
    expect(deriveValueFieldLabel('net_sales', [])).toBe('Net Sales');
  });

  it('transforms camelCase field id to Title Case as fallback', () => {
    expect(deriveValueFieldLabel('orderCount', [])).toBe('Order Count');
  });

  it('transforms snake_case field id to Title Case as fallback', () => {
    expect(deriveValueFieldLabel('order_total_amount', [])).toBe('Order Total Amount');
  });

  it('prefers declared label even when it differs from the transformed id', () => {
    const fields = [{ id: 'rev', label: 'Revenue (USD)' }];
    expect(deriveValueFieldLabel('rev', fields)).toBe('Revenue (USD)');
  });
});
