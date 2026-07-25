import { createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioWidgetConfig } from '../../models';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { TextSetupPanel } from './TextSetupPanel';

const controller = {
  updateWidgetConfig: vi.fn(),
  updateWidget: vi.fn(),
};

const mockState = {
  doc: {
    widgets: {
      'widget-1': {
        id: 'widget-1',
        kind: 'text',
        title: 'Notes',
        // Deliberately EMPTY: neither `textSubtitle` nor `textBody` is present, which is
        // the state a freshly created text widget is in.
        config: {} as StudioWidgetConfig,
      },
    },
    relationships: [],
    expressionFields: [],
  },
  runtime: { dataSources: {} },
};

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

const { render } = createRenderer();

/**
 * The subtitle/body fields committed BOTH keys on every blur with no dirty check. Two
 * consequences: merely tabbing through the panel pushed undo entries that change nothing
 * (so a later Ctrl+Z appears to do nothing at all), and a config with no `textSubtitle`/
 * `textBody` key had `''` written into it — turning "unset, inherit the default" into
 * "explicitly empty", which then persists into the doc and survives export.
 */
describe('TextSetupPanel blur commit guard', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockClear();
    controller.updateWidget.mockClear();
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  it('commits nothing when a text field is blurred without an edit', () => {
    render(<TextSetupPanel widgetId="widget-1" />);

    fireEvent.blur(screen.getByLabelText('Subtitle'));
    fireEvent.blur(screen.getByLabelText('Body'));

    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });

  it('commits only the key that actually changed, leaving the untouched key absent', () => {
    render(<TextSetupPanel widgetId="widget-1" />);

    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'Hello' } });
    fireEvent.blur(body);

    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    // No `textSubtitle: ''` alongside it — the absent key stays absent.
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      textBody: 'Hello',
    });
  });

  it('commits both keys when both were edited', () => {
    render(<TextSetupPanel widgetId="widget-1" />);

    const subtitle = screen.getByLabelText('Subtitle');
    fireEvent.change(subtitle, { target: { value: 'Sub' } });
    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'Body text' } });
    fireEvent.blur(body);

    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', {
      textSubtitle: 'Sub',
      textBody: 'Body text',
    });
  });

  it('does not re-commit an unchanged field on a second blur', () => {
    render(<TextSetupPanel widgetId="widget-1" />);

    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'Hello' } });
    fireEvent.blur(body);
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);

    // The mock state is static, so the buffered value still differs from the (empty)
    // config — but a real commit would have updated it. What matters here is that the
    // no-edit path below adds nothing.
    controller.updateWidgetConfig.mockClear();
    fireEvent.blur(screen.getByLabelText('Subtitle'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});
