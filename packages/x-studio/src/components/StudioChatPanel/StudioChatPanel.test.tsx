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
import { createRenderer, screen, fireEvent, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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
  // Read by `richContext.ts`'s `buildRichContext` (called whenever `privateMode` is
  // not set) via the real `createBackendChatAdapter` these auto-submit tests exercise.
  getRecentMutations: vi.fn(() => []),
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

// ── slotProps.chatBox.messages contract (regression: 2.8) ───────────────────
//
// The `StudioChatPanelSlotProps.chatBox` JSDoc documents `messages` as always set
// by Studio and "cannot be overridden here" — a consumer-supplied `messages`/
// `onMessagesChange` must be ignored, not honored, or the rendered ChatBox would
// show the consumer's array while Studio's own `handleMessagesChange` keeps
// writing stream deltas into controller thread state, silently diverging the two.
describe('StudioChatPanel: slotProps.chatBox messages contract', () => {
  const aiConfig: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };

  it('ignores a consumer-supplied slotProps.chatBox.messages override', () => {
    const consumerMessages = [
      { id: 'fake-1', role: 'user' as const, parts: [{ type: 'text' as const, text: 'not real' }] },
    ];

    render(
      <StudioChatPanel
        aiConfig={aiConfig}
        slotProps={{ chatBox: { messages: consumerMessages } }}
      />,
    );

    const props = chatBoxSpy.mock.calls.at(-1)?.[0] as {
      messages?: unknown;
    };
    // Studio's own (empty, for a brand-new thread) messages array is used instead
    // of the consumer's override.
    expect(props.messages).not.toBe(consumerMessages);
    expect(props.messages).toEqual([]);
  });

  it('ignores a consumer-supplied slotProps.chatBox.onMessagesChange override', () => {
    const consumerOnMessagesChange = vi.fn();

    render(
      <StudioChatPanel
        aiConfig={aiConfig}
        slotProps={{ chatBox: { onMessagesChange: consumerOnMessagesChange } }}
      />,
    );

    const props = chatBoxSpy.mock.calls.at(-1)?.[0] as {
      onMessagesChange?: unknown;
    };
    expect(props.onMessagesChange).not.toBe(consumerOnMessagesChange);
  });
});

// ── Auto-submit: initialPrompt / pendingMessage (regressions: 2.1, 2.2, 2.9) ────
//
// These exercise the real `createBackendChatAdapter` (not mocked) with a stubbed
// `fetch` returning a minimal SSE `finish` response, so the actual composer submit
// → adapter.sendMessage → stream-completion round trip runs, letting the
// auto-submit queue's `isSubmitting`-gated retry (finding 2.2) and ordering
// (finding 2.9) be observed through real request bodies.

function makeFinishSseResponse() {
  return {
    ok: true,
    body: new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('data: {"type":"finish","finishReason":"stop"}\n\n'));
        ctrl.close();
      },
    }),
  };
}

async function flushAsync(rounds = 20) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

describe('StudioChatPanel: auto-submit queue', () => {
  const aiConfig: StudioAIConfig = { endpoint: 'https://fake.test/api/ai' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto-submits initialPrompt on mount for a brand-new (empty) thread (baseline)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeFinishSseResponse()));
    vi.stubGlobal('fetch', fetchMock);

    render(<StudioChatPanel aiConfig={aiConfig} initialPrompt="Explain this widget" />);
    await flushAsync();

    expect(fetchMock).toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { messages: { parts: { text: string }[] }[] };
    expect(body.messages.at(-1)?.parts[0]?.text).toBe('Explain this widget');
  });

  it('does not auto-submit the stale initialPrompt into a new thread created after mount (regression: 2.1)', async () => {
    // Mount with an EXISTING, non-empty conversation — `initialPrompt` is not eligible
    // at mount (the guard requires an empty thread). Without the mount-thread pin, the
    // guard would later re-satisfy "thread is empty" the moment the user starts a
    // brand-new conversation, auto-submitting the stale, mount-time prompt into a
    // thread the user never asked about.
    mockState = createDefaultStudioState({
      doc: {
        ai: {
          threads: [
            {
              id: 'thread-1',
              name: 'Existing conversation',
              createdAt: new Date().toISOString(),
              messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }] as any,
            },
          ],
          activeThreadId: 'thread-1',
        },
      },
    });
    configureStudioContextMock({ getState: () => mockState, controller });

    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeFinishSseResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <StudioChatPanel aiConfig={aiConfig} initialPrompt="Explain this widget" />,
    );
    await flushAsync(3);

    // Not eligible at mount (the thread wasn't empty) — no request yet.
    expect(fetchMock).not.toHaveBeenCalled();
    const threadIdAtMount = mockState.doc.ai?.activeThreadId;
    const rendersBeforeClick = chatBoxSpy.mock.calls.length;

    // User starts a brand-new (empty) conversation.
    fireEvent.click(
      screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatNewConversationName }),
    );
    // The shared `studioContextMock` replaces `useStudioSelector` with a plain
    // `selector(getState())` and NO store subscription, so a controller write never
    // re-renders anything by itself — the click above mutates `mockState` and nothing
    // else happens. Without this explicit rerender the panel never re-reads
    // `activeThreadId`, the `initialPrompt` effect never re-runs, and this test would
    // pass with the `mountThreadIdRef` pin (the whole fix it exists for) deleted.
    // See the note in `test/studioContextMock.ts`: any behaviour that depends on
    // re-rendering from a store change has to be driven manually here.
    rerender(<StudioChatPanel aiConfig={aiConfig} initialPrompt="Explain this widget" />);
    await flushAsync();

    // Sanity: the scenario this test is about actually happened — a DIFFERENT thread
    // is active, and the panel re-rendered against it (so the `initialPrompt` effect
    // really did get another chance to fire).
    expect(mockState.doc.ai?.activeThreadId).not.toBe(threadIdAtMount);
    expect(chatBoxSpy.mock.calls.length).toBeGreaterThan(rendersBeforeClick);

    // The stale, mount-time initialPrompt must never be auto-submitted into this new
    // thread — it was only ever eligible for the thread active at mount.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits both a pendingMessage and an initialPrompt queued on the same mount, in order (regression: 2.9)', async () => {
    const requestBodies: { messages: { parts: { text: string }[] }[] }[] = [];
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      requestBodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(makeFinishSseResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <StudioChatPanel
        aiConfig={aiConfig}
        initialPrompt="Explain this widget"
        pendingMessage={{ text: 'Insight please', id: 1 }}
      />,
    );
    await flushAsync();

    // Neither producer clobbered the other's entry — both were eventually sent, and
    // each exactly once. (`toBeGreaterThanOrEqual(2)` passed on five duplicate
    // submissions, in the file whose entire purpose is guarding duplicate
    // auto-submission.)
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const lastMessageTexts = requestBodies.map((body) => body.messages.at(-1)?.parts?.[0]?.text);
    expect(lastMessageTexts).toContain('Insight please');
    expect(lastMessageTexts).toContain('Explain this widget');
    // `pendingMessage`'s effect runs (and thus enqueues) before the `initialPrompt`
    // effect, so it is submitted first — the queue is FIFO.
    expect(lastMessageTexts[0]).toBe('Insight please');
  });

  it('does not drop a pendingMessage that arrives while a previous auto-submit is still streaming (regression: 2.2)', async () => {
    // Two separate `pendingMessage` triggers delivered close together (e.g. two
    // rapid widget "AI insight" clicks) — the second must not be silently dropped
    // just because the first's response is still streaming when it arrives.
    let resolveFirst: (() => void) | undefined;
    const fetchMock = vi.fn().mockImplementation(() => {
      if (!resolveFirst) {
        // First call: hang until the test explicitly resolves it, simulating an
        // in-flight stream.
        return new Promise((resolve) => {
          resolveFirst = () => resolve(makeFinishSseResponse());
        });
      }
      return Promise.resolve(makeFinishSseResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <StudioChatPanel aiConfig={aiConfig} pendingMessage={{ text: 'First', id: 1 }} />,
    );
    await flushAsync(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A second pendingMessage arrives while the first request is still in flight.
    rerender(<StudioChatPanel aiConfig={aiConfig} pendingMessage={{ text: 'Second', id: 2 }} />);
    await flushAsync(3);
    // Still only one request so far — the second must not have been silently
    // dropped, but it also must not be sent while the first is streaming.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Let the first request's stream complete.
    resolveFirst?.();
    await flushAsync();

    // The second message is retried once streaming ends, not lost — and retried ONCE.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(
      String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body),
    ) as { messages: { parts: { text: string }[] }[] };
    expect(secondCallBody.messages.at(-1)?.parts[0]?.text).toBe('Second');
  });

  // ── Overlay close/reopen must not resubmit a stale entry (finding 5) ────────
  //
  // A widget-insight click auto-submits a prompt into the overlay via `pendingMessage`.
  // The overlay is a `<Grow in={open} mountOnEnter unmountOnExit>` — closing it
  // unmounts `AutoSubmitTrigger` (nested inside `ChatBox`), and reopening it mounts a
  // fresh instance. Before the fix, dedup lived in a `useRef` local to
  // `AutoSubmitTrigger`, which reset to empty on every remount: a fresh mount would
  // find the still-present, already-submitted queue entry and resubmit it — a
  // duplicate (paid) LLM call on every reopen. The fix prunes an entry out of the
  // `pendingAutoSubmit` state queue itself once actually submitted, so a remount has
  // nothing stale left to reprocess.
  it('does not resubmit a stale pendingMessage entry when the overlay is closed and reopened (regression: finding 5)', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(makeFinishSseResponse()));
    vi.stubGlobal('fetch', fetchMock);

    const onClose = vi.fn();
    const pendingMessage = { text: 'Explain this widget', id: 1 };

    const { rerender } = render(
      <StudioChatPanel
        aiConfig={aiConfig}
        overlay
        open
        onClose={onClose}
        pendingMessage={pendingMessage}
      />,
    );
    await flushAsync();
    // The insight prompt was auto-submitted exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Close the overlay — `<Grow unmountOnExit>` tears down the chat box (and thus
    // `AutoSubmitTrigger`) once the exit transition completes.
    rerender(
      <StudioChatPanel
        aiConfig={aiConfig}
        overlay
        open={false}
        onClose={onClose}
        pendingMessage={pendingMessage}
      />,
    );
    await flushAsync();
    // Confirms the overlay (and `AutoSubmitTrigger` inside it) actually left the DOM —
    // otherwise this test wouldn't be exercising the remount this regression is about.
    expect(screen.queryByRole('dialog')).toBeNull();

    // Reopen — same `pendingMessage` prop (same `id`, since no NEW insight request
    // fired), mounting a brand-new `AutoSubmitTrigger` with no memory of the past.
    rerender(
      <StudioChatPanel
        aiConfig={aiConfig}
        overlay
        open
        onClose={onClose}
        pendingMessage={pendingMessage}
      />,
    );
    await flushAsync();

    // The already-submitted entry must not be resubmitted just because its consumer
    // remounted — still exactly one request, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
