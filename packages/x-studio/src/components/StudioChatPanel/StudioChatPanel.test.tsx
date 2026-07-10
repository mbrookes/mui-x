/**
 * Basic rendering coverage for `StudioChatPanel` — previously untested (Tier-4
 * gap #5 in the architecture review). Thread create/switch/persistence and the
 * message write-back race fix are covered in depth in `useChatThreads.test.ts`;
 * this file only verifies the panel mounts, wires the mock controller/context
 * correctly, and respects the `aiConfig`-gated render.
 *
 * Context is mocked via the shared `studioContextMock` (required because this
 * repo runs vitest with `isolate: false` — see that module's doc comment).
 */
import * as React from 'react';
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioState } from '../../models';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { frLocaleText } from '../../locales/fr';
import {
  mockUseStudioSelector,
  mockUseStudioController,
  configureStudioContextMock,
} from '../../../test/studioContextMock';
import { StudioChatPanel } from './StudioChatPanel';
import type { StudioAIConfig } from './studioBackendAdapter';

// Shared context mock (see test/studioContextMock.ts) — required because the repo runs
// vitest with `isolate: false`, so a per-file mock factory would leak across files.
vi.mock('../../context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../context')>()),
  useStudioSelector: mockUseStudioSelector,
  useStudioController: mockUseStudioController,
}));

// Spy on the `localeText` object Studio builds for `ChatBox` (composerInputPlaceholder /
// threadNoMessagesLabel / threadNoMessagesHelperText) without disturbing real rendering —
// `generateSuggestions` always returns at least one suggestion in this test's fixtures, so
// the empty-thread title/helper text ChatBox would show is never actually reachable in the
// DOM; asserting on the mapped prop object directly is what actually pins the fix.
const chatBoxSpy = vi.fn();
vi.mock('@mui/x-chat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mui/x-chat')>();
  return {
    ...actual,
    ChatBox: (props: React.ComponentProps<typeof actual.ChatBox>) => {
      chatBoxSpy(props);
      return <actual.ChatBox {...props} />;
    },
  };
});

// Mutable so individual tests can swap in a translated locale bundle (see the
// anti-hardcoding regression tests below) — a plain `vi.mock` factory value is
// captured once at hoist time and can't be reassigned per-test.
let mockLocaleText = DEFAULT_STUDIO_LOCALE_TEXT;

vi.mock('../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioLocaleText: () => mockLocaleText,
  };
});

// ── Shared mutable state / controller ────────────────────────────────────────

let mockState: StudioState;

const controller = {
  getState: vi.fn(() => mockState),
  setState: vi.fn((next: StudioState) => {
    mockState = next;
  }),
};

const { render } = createRenderer();

beforeEach(() => {
  mockState = createDefaultStudioState();
  configureStudioContextMock({ getState: () => mockState, controller });
  mockLocaleText = DEFAULT_STUDIO_LOCALE_TEXT;
});

describe('StudioChatPanel: aiConfig gating', () => {
  it('renders nothing when aiConfig is not provided', () => {
    const { container } = render(<StudioChatPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when aiConfig has no endpoint', () => {
    const { container } = render(<StudioChatPanel aiConfig={{ endpoint: '' }} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when aiConfig is explicitly null', () => {
    const { container } = render(<StudioChatPanel aiConfig={null} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('StudioChatPanel: basic rendering', () => {
  const aiConfig: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };

  it('renders the thread header and composer when aiConfig is provided', () => {
    render(<StudioChatPanel aiConfig={aiConfig} />);

    // Thread selector shows the default conversation name.
    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.chatNewConversationName)).toBeDefined();
    // Composer input is present (Studio-provided placeholder).
    expect(
      screen.getByPlaceholderText(DEFAULT_STUDIO_LOCALE_TEXT.chatComposerPlaceholder),
    ).toBeDefined();
  });

  it('localizes the composer placeholder instead of hardcoding English', () => {
    mockLocaleText = { ...DEFAULT_STUDIO_LOCALE_TEXT, ...frLocaleText };

    render(<StudioChatPanel aiConfig={aiConfig} />);

    expect(screen.getByPlaceholderText(frLocaleText.chatComposerPlaceholder!)).toBeDefined();
    expect(screen.queryByPlaceholderText('How can I help?')).toBeNull();
  });

  it('maps the empty-thread title/helper text ChatBox override to localized tokens', () => {
    // `generateSuggestions` always returns at least one suggestion for this fixture (no
    // data sources/widgets), so ChatBox's default empty-state title/helper never actually
    // renders (suggestions take its place) — assert on the prop object Studio builds
    // instead of the (unreachable) rendered DOM.
    mockLocaleText = { ...DEFAULT_STUDIO_LOCALE_TEXT, ...frLocaleText };

    render(<StudioChatPanel aiConfig={aiConfig} />);

    const props = chatBoxSpy.mock.calls.at(-1)?.[0] as {
      localeText?: { threadNoMessagesLabel?: string; threadNoMessagesHelperText?: string };
    };
    expect(props.localeText?.threadNoMessagesLabel).toBe(frLocaleText.chatEmptyStateTitle);
    expect(props.localeText?.threadNoMessagesHelperText).toBe(frLocaleText.chatEmptyStateSubtitle);
  });

  it('renders an overlay panel with a close button when overlay + onClose are set', () => {
    const onClose = vi.fn();
    render(<StudioChatPanel aiConfig={aiConfig} overlay open onClose={onClose} />);

    const closeButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.aiAssistantCloseTooltip,
    });
    expect(closeButton).toBeDefined();
    // Overlay header title is localized (not hardcoded "AI Assistant").
    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.aiAssistantPanelTitle)).toBeDefined();
  });

  it('localizes the overlay panel title instead of hardcoding English', () => {
    mockLocaleText = { ...DEFAULT_STUDIO_LOCALE_TEXT, ...frLocaleText };

    render(<StudioChatPanel aiConfig={aiConfig} overlay open onClose={vi.fn()} />);

    expect(screen.getByText(frLocaleText.aiAssistantPanelTitle!)).toBeDefined();
    expect(screen.queryByText('AI Assistant')).toBeNull();
  });

  // ── Overlay dialog semantics (finding 2.22) ─────────────────────────────────

  it('exposes the overlay panel as a dialog labelled by its heading', () => {
    render(<StudioChatPanel aiConfig={aiConfig} overlay open onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog');
    // The dialog's accessible name comes from its "AI assistant" heading via
    // aria-labelledby (previously the heading was unassociated).
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading?.textContent).toBe(DEFAULT_STUDIO_LOCALE_TEXT.aiAssistantPanelTitle);
  });

  it('closes the overlay panel when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<StudioChatPanel aiConfig={aiConfig} overlay open onClose={onClose} />);

    // Escape is handled via bubbling from wherever focus currently sits — the panel
    // moves focus into the composer textarea on open, and jsdom keydown can only
    // target the actual active element, so fire it there rather than on the dialog
    // container.
    const composer = screen.getByPlaceholderText(
      DEFAULT_STUDIO_LOCALE_TEXT.chatComposerPlaceholder,
    );
    expect(composer).toHaveFocus();
    fireEvent.keyDown(composer, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('starts a brand-new thread with no prior threads in state', () => {
    render(<StudioChatPanel aiConfig={aiConfig} />);
    // No threads exist yet in state.doc.ai, so nothing has been persisted —
    // the default in-memory thread name is shown without writing to state.
    expect(mockState.doc.ai).toBeUndefined();
    expect(screen.getByText(DEFAULT_STUDIO_LOCALE_TEXT.chatNewConversationName)).toBeDefined();
  });

  it("shows the active thread's name when one is already selected in state", () => {
    mockState = createDefaultStudioState({
      doc: {
        ai: {
          threads: [
            {
              id: 'thread-1',
              name: 'Q3 planning',
              createdAt: new Date().toISOString(),
              messages: [],
            },
          ],
          activeThreadId: 'thread-1',
        },
      },
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    render(<StudioChatPanel aiConfig={aiConfig} />);
    expect(screen.getByText('Q3 planning')).toBeDefined();
  });
});
