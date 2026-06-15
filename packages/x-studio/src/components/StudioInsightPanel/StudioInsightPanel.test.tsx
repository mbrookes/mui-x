import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { StudioInsightPanel } from './StudioInsightPanel';

const { render } = createRenderer();

function setup(props: Partial<React.ComponentProps<typeof StudioInsightPanel>> = {}) {
  const onClose = vi.fn();
  const onRegenerate = vi.fn();
  const { wrapper } = createStudioHarness();
  const view = render(
    <StudioInsightPanel
      insight={{ text: 'Revenue grew 12% QoQ.' }}
      loading={false}
      error={null}
      onClose={onClose}
      onRegenerate={onRegenerate}
      activeType="summary"
      {...props}
    />,
    { wrapper },
  );
  return { ...view, onClose, onRegenerate };
}

describe('StudioInsightPanel', () => {
  it('renders the insight text when not loading and no error', () => {
    setup();
    expect(screen.getByText('Revenue grew 12% QoQ.')).not.toBe(null);
  });

  it('shows a progress indicator while loading', () => {
    setup({ loading: true, insight: null });
    expect(screen.getByRole('progressbar')).not.toBe(null);
    expect(screen.queryByText('Revenue grew 12% QoQ.')).toBe(null);
  });

  it('shows the error message when generation failed', () => {
    setup({ loading: false, error: 'Generation failed', insight: null });
    expect(screen.getByText('Generation failed')).not.toBe(null);
  });

  it('offers summary and analysis types by default, adding forecast when enabled', () => {
    const { rerender } = setup();
    expect(screen.getByRole('button', { name: 'Summary' })).not.toBe(null);
    expect(screen.getByRole('button', { name: 'Analysis' })).not.toBe(null);
    expect(screen.queryByRole('button', { name: 'Forecast' })).toBe(null);

    rerender(
      <StudioInsightPanel
        insight={null}
        loading={false}
        error={null}
        onClose={vi.fn()}
        onRegenerate={vi.fn()}
        activeType="summary"
        showForecast
      />,
    );
    expect(screen.getByRole('button', { name: 'Forecast' })).not.toBe(null);
  });

  it('calls onRegenerate with the chosen type from the switcher', async () => {
    const { user, onRegenerate } = setup();
    await user.click(screen.getByRole('button', { name: 'Analysis' }));
    expect(onRegenerate).toHaveBeenCalledWith('analysis');
  });

  it('regenerates the active type from the refresh button', async () => {
    const { user, onRegenerate } = setup({ activeType: 'analysis' });
    await user.click(screen.getByTestId('RefreshIcon'));
    expect(onRegenerate).toHaveBeenCalledWith('analysis');
  });

  it('disables the refresh button while loading', () => {
    setup({ loading: true, insight: null });
    expect(screen.getByTestId('RefreshIcon').closest('button')).toHaveProperty('disabled', true);
  });

  it('calls onClose from the close button', async () => {
    const { user, onClose } = setup();
    await user.click(screen.getByTestId('CloseIcon').closest('button')!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows the copy button only when an insight is present', () => {
    setup();
    expect(screen.getByTestId('ContentCopyIcon')).not.toBe(null);
  });

  it('hides the copy button when there is no insight', () => {
    setup({ insight: null });
    expect(screen.queryByTestId('ContentCopyIcon')).toBe(null);
  });
});
