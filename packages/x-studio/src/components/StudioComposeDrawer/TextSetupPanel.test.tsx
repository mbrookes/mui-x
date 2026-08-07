import { act, createRenderer, fireEvent, screen } from '@mui/internal-test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioController } from '@mui/x-studio-core/store';
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
    // `mockReset`, not `mockClear`: one test below installs a write-back implementation, and
    // `mockClear` only wipes the call log, so the implementation would leak into later tests.
    controller.updateWidgetConfig.mockReset();
    controller.updateWidget.mockReset();
    mockState.doc.widgets['widget-1'].config = {} as StudioWidgetConfig;
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
    // The guard compares the local buffer against the CURRENT config, so this test only
    // means something if the commit actually lands — with an inert `vi.fn()` the config
    // stays `{}` forever, the buffer stays permanently "dirty", and a correct guard would
    // still be obliged to re-commit. Mirror a real store: apply the patch, then re-render so
    // the panel observes it (the real store notifies its subscribers here).
    controller.updateWidgetConfig.mockImplementation(
      (_widgetId: string, changes: Partial<StudioWidgetConfig>) => {
        mockState.doc.widgets['widget-1'].config = {
          ...mockState.doc.widgets['widget-1'].config,
          ...changes,
        } as StudioWidgetConfig;
      },
    );

    // `nonce` only exists to force the re-render the real store would have triggered.
    function Wrapper(props: { nonce: number }) {
      return (
        <div data-nonce={props.nonce}>
          <TextSetupPanel widgetId="widget-1" />
        </div>
      );
    }

    const { setProps } = render(<Wrapper nonce={0} />);

    const body = screen.getByLabelText('Body');
    fireEvent.change(body, { target: { value: 'Hello' } });
    fireEvent.blur(body);
    expect(controller.updateWidgetConfig).toHaveBeenCalledTimes(1);
    expect(controller.updateWidgetConfig).toHaveBeenCalledWith('widget-1', { textBody: 'Hello' });

    setProps({ nonce: 1 });

    // Body is now clean (buffer === committed config) and Subtitle was never edited, so
    // blurring commits nothing at all — no empty-string write, no no-op undo entry.
    controller.updateWidgetConfig.mockClear();
    fireEvent.blur(screen.getByLabelText('Subtitle'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();

    // ...and re-blurring Body itself is equally inert.
    fireEvent.blur(screen.getByLabelText('Body'));
    expect(controller.updateWidgetConfig).not.toHaveBeenCalled();
  });
});

// ─── Finding 5: an external change must not discard an in-progress edit ────────
//
// Title, subtitle and body share one `form` object and the resync effect had no dirty
// tracking at all, so it overwrote the WHOLE object on any external change. The compose
// drawer and the AI chat panel are usable at the same time and the AI tool surface includes
// `update_widget`, so a write to `textBody` landed mid-typing and silently discarded the
// uncommitted title.
describe('TextSetupPanel — per-field dirty-aware resync (finding 5)', () => {
  beforeEach(() => {
    controller.updateWidgetConfig.mockReset();
    controller.updateWidget.mockReset();
    mockState.doc.widgets['widget-1'] = {
      id: 'widget-1',
      kind: 'text',
      title: 'Notes',
      config: {} as StudioWidgetConfig,
    };
    configureStudioContextMock({ getState: () => mockState, controller });
  });

  // `nonce` only exists to force the re-render the real store would have triggered.
  function Wrapper(props: { nonce: number }) {
    return (
      <div data-nonce={props.nonce}>
        <TextSetupPanel widgetId="widget-1" />
      </div>
    );
  }

  it('keeps an uncommitted title edit when an external write changes the body', async () => {
    const { user, setProps } = render(<Wrapper nonce={0} />);

    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, 'Draft title');
    expect(titleInput.value).toBe('Draft title');

    // An external write (AI `update_widget` / host `setState`) touches ONLY the body.
    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      config: { textBody: 'Written by the assistant' } as StudioWidgetConfig,
    };
    setProps({ nonce: 1 });

    // The dirty title buffer survives...
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Draft title');
    // ...while the clean body field still tracks the store.
    expect((screen.getByLabelText('Body') as HTMLInputElement).value).toBe(
      'Written by the assistant',
    );
  });

  it('still resyncs a clean field when the store changes it (undo/redo, external edit)', () => {
    const { setProps } = render(<Wrapper nonce={0} />);

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Notes');

    mockState.doc.widgets['widget-1'] = {
      ...mockState.doc.widgets['widget-1'],
      title: 'Release notes',
    };
    setProps({ nonce: 1 });

    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Release notes');
  });

  it('commits nothing when the title is blurred without an edit', () => {
    render(<TextSetupPanel widgetId="widget-1" />);

    fireEvent.blur(screen.getByLabelText('Title'));

    expect(controller.updateWidget).not.toHaveBeenCalled();
  });
});

// ─── The same rule, driven by a REAL store write ──────────────────────────────
//
// The block above simulates the store notification with a `nonce` prop, because the
// shared context mock's default (snapshot) mode reads `getState()` once per render and
// subscribes to nothing. That leaves one half of the claim untested: a panel that read
// the widget from a NON-reactive source — a ref, a one-time `controller.getState()`, a
// prop threaded down by the drawer — would satisfy every `nonce`-driven assertion above,
// because the nonce re-renders it regardless of where it read from. So "the AI writes
// `update_widget` while the drawer is open and the user sees it" was not pinned anywhere.
//
// Here the mock runs in subscribed mode against a real `StudioController`'s store, so the
// only thing that can re-render the panel is the panel's own subscription, and the write
// is a real `updateWidgetConfig` rather than a hand-edited fixture.
describe('TextSetupPanel — resync driven by a real store write (subscribed mock)', () => {
  let realController: StudioController;

  beforeEach(() => {
    realController = new StudioController({
      doc: {
        widgets: {
          'widget-1': {
            id: 'widget-1',
            kind: 'text',
            title: 'Notes',
            config: {} as StudioWidgetConfig,
          },
        },
      },
    });
    configureStudioContextMock({ store: realController.store, controller: realController });
  });

  it('shows an external write to the body without any manual re-render', async () => {
    render(<TextSetupPanel widgetId="widget-1" />);

    expect((screen.getByLabelText('Body') as HTMLInputElement).value).toBe('');

    // Exactly what the AI chat panel's `update_widget` tool does while the drawer is open.
    await act(async () => {
      realController.updateWidgetConfig('widget-1', {
        textBody: 'Written by the assistant',
      } as Partial<StudioWidgetConfig>);
    });

    expect((screen.getByLabelText('Body') as HTMLInputElement).value).toBe(
      'Written by the assistant',
    );
  });

  it('keeps an in-flight title edit when that write lands mid-keystroke', async () => {
    const { user } = render(<TextSetupPanel widgetId="widget-1" />);

    const titleInput = screen.getByLabelText('Title') as HTMLInputElement;
    await user.clear(titleInput);
    await user.type(titleInput, 'Draft title');
    expect(titleInput.value).toBe('Draft title');

    await act(async () => {
      realController.updateWidgetConfig('widget-1', {
        textBody: 'Written by the assistant',
      } as Partial<StudioWidgetConfig>);
    });

    // The dirty buffer wins over the external write...
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe('Draft title');
    // ...and the clean sibling still tracked it, so the panel really did re-render.
    expect((screen.getByLabelText('Body') as HTMLInputElement).value).toBe(
      'Written by the assistant',
    );
  });
});
