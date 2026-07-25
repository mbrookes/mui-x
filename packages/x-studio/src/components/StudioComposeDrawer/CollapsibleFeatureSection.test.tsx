import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { CollapsibleFeatureSection } from './CollapsibleFeatureSection';

const { render } = createRenderer();

/**
 * M11 — a disabled feature's controls were only dimmed (`opacity`) and mouse-blocked
 * (`pointerEvents: 'none'`). `Collapse` keeps its children mounted, and the header chevron
 * expands the section independently of the switch, so a keyboard user could tab straight
 * into the controls of a switched-off feature and commit config for it. `inert` is the
 * primitive that actually matches the intent: it removes the subtree from the tab order,
 * from hit-testing and from the accessibility tree at once.
 */
describe('CollapsibleFeatureSection disabled-content inertness (M11)', () => {
  function renderSection(enabled: boolean) {
    return render(
      <CollapsibleFeatureSection label="Forecast" enabled={enabled} onToggle={vi.fn()}>
        <input aria-label="horizon" />
      </CollapsibleFeatureSection>,
    );
  }

  it('marks the content inert while the feature switch is off', () => {
    renderSection(false);
    // Expand via the header — reachable regardless of the switch state, which is exactly
    // how a disabled feature's controls became tabbable.
    fireEvent.click(screen.getByRole('button', { name: 'Forecast' }));

    const region = screen.getByLabelText('horizon').closest('[inert]');
    expect(region).not.toBe(null);
  });

  it('does not mark the content inert while the feature is on', () => {
    renderSection(true);
    fireEvent.click(screen.getByRole('button', { name: 'Forecast' }));

    expect(screen.getByLabelText('horizon').closest('[inert]')).toBe(null);
  });

  it('drops inertness as soon as the feature is switched on', () => {
    const { setProps } = render(
      <CollapsibleFeatureSection label="Forecast" enabled={false} onToggle={vi.fn()}>
        <input aria-label="horizon" />
      </CollapsibleFeatureSection>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Forecast' }));
    expect(screen.getByLabelText('horizon').closest('[inert]')).not.toBe(null);

    setProps({ enabled: true });
    expect(screen.getByLabelText('horizon').closest('[inert]')).toBe(null);
  });
});
