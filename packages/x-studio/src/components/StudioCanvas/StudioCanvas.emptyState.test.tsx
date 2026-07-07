import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import { createStudioHarness } from '../../internals/test-utils';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { frLocaleText } from '../../locales/fr';
import { StudioCanvas } from './StudioCanvas';

const { render } = createRenderer();

/**
 * Regression coverage for the empty-canvas state strings (previously hardcoded
 * English literals: "Canvas is empty", "Use the Compose panel to add widgets or
 * drag them here.", "Switch to Edit mode to add widgets.") — now sourced from
 * `localeText.canvasEmptyTitle` / `canvasEmptyEditModeHint` / `canvasEmptyViewModeHint`.
 */
describe('StudioCanvas empty state localization', () => {
  it('shows the default English empty-state copy in edit mode', () => {
    const { wrapper } = createStudioHarness({
      initialState: { doc: { pages: {}, widgets: {} } },
    });
    render(<StudioCanvas />, { wrapper });

    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.canvasEmptyTitle)).toBeVisible();
    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.canvasEmptyEditModeHint)).toBeVisible();
  });

  it('shows the localized empty-state copy in edit mode and not the English literal', () => {
    const { wrapper } = createStudioHarness({
      initialState: { doc: { pages: {}, widgets: {} } },
      providerProps: { localeText: frLocaleText },
    });
    render(<StudioCanvas />, { wrapper });

    expect(screen.getByText(frLocaleText.canvasEmptyTitle!)).toBeVisible();
    expect(screen.getByText(frLocaleText.canvasEmptyEditModeHint!)).toBeVisible();
    expect(screen.queryByText('Canvas is empty')).toBeNull();
    expect(
      screen.queryByText('Use the Compose panel to add widgets or drag them here.'),
    ).toBeNull();
  });

  it('shows the localized view-mode hint and not the English literal', () => {
    const { wrapper } = createStudioHarness({
      initialState: { doc: { pages: {}, widgets: {} }, session: { mode: 'view' } },
      providerProps: { localeText: frLocaleText },
    });
    render(<StudioCanvas />, { wrapper });

    expect(screen.getByText(frLocaleText.canvasEmptyViewModeHint!)).toBeVisible();
    expect(screen.queryByText('Switch to Edit mode to add widgets.')).toBeNull();
  });
});
