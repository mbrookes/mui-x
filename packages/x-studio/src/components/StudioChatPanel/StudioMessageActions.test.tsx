/**
 * Coverage for `StudioMessageActions` — the hover-reveal copy + retry buttons on
 * each chat message. Focus: the retry action must REGENERATE the assistant reply
 * in place (`chat.regenerate`) rather than re-sending the user message via
 * `sendMessage`, which would append a duplicate user turn + a second answer
 * (architecture review finding 2.10).
 *
 * The headless chat hooks are mocked so the component can be driven without a full
 * ChatBox/provider tree.
 */
import * as React from 'react';
import { createRenderer, screen, fireEvent, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/localeText';
import { StudioMessageActions } from './StudioMessageActions';
import {
  StudioChatTurnMutationContext,
  createChatTurnMutationLedger,
  type StudioChatTurnMutationLedger,
} from './chatTurnMutations';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const regenerateSpy = vi.fn().mockResolvedValue(undefined);
const sendMessageSpy = vi.fn();

let mockMessage: { id: string; role: string; parts: { type: string; text: string }[] } | null;
let mockIsStreaming = false;

vi.mock('@mui/x-chat/headless', () => ({
  useMessage: () => mockMessage,
  useChat: () => ({
    regenerate: regenerateSpy,
    sendMessage: sendMessageSpy,
    isStreaming: mockIsStreaming,
    messages: mockMessage ? [mockMessage] : [],
  }),
}));

vi.mock('../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioLocaleText: () => DEFAULT_STUDIO_LOCALE_TEXT,
  };
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StudioMessageActions', () => {
  const { render } = createRenderer();

  beforeEach(() => {
    regenerateSpy.mockClear();
    regenerateSpy.mockResolvedValue(undefined);
    sendMessageSpy.mockClear();
    mockIsStreaming = false;
  });

  it('regenerates the assistant reply in place on retry (regression: 2.10)', async () => {
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    };
    render(<StudioMessageActions messageId="assistant-1" />);

    fireEvent.click(
      screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
    );
    // Flush the microtask queue so the in-flight guard's `finally` (which
    // resolves after `regenerateSpy`'s promise) settles.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Regenerate is targeted at THIS assistant message; sendMessage is never used
    // (using it would append a duplicate user turn + answer).
    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(regenerateSpy).toHaveBeenCalledWith('assistant-1');
    expect(sendMessageSpy).not.toHaveBeenCalled();
  });

  it('drops a concurrent duplicate retry click on the same message (double-apply guard)', async () => {
    // Regression coverage: retrying a response that already partially applied
    // mutations must not let a second, concurrent click re-trigger regenerate
    // for the same message before the first call has settled.
    let resolveRegenerate: () => void = () => {};
    regenerateSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRegenerate = resolve;
        }),
    );
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    };
    render(<StudioMessageActions messageId="assistant-1" />);
    const retryButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip,
    });

    // `fireEvent.click` auto-wraps each dispatch in `act`, so these three calls
    // re-render between clicks (unlike batching all three inside one manual
    // `act()`), letting the `isRegenerating` guard actually take effect between them.
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    expect(regenerateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRegenerate();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Once the in-flight regenerate settles, a fresh retry is allowed again.
    fireEvent.click(retryButton);
    expect(regenerateSpy).toHaveBeenCalledTimes(2);
  });

  it('does not render a retry button on user messages', () => {
    mockMessage = {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'question' }],
    };
    render(<StudioMessageActions messageId="user-1" />);

    expect(
      screen.queryByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
    ).to.equal(null);
  });

  // Regression coverage: the component used to `return null` for the whole message-
  // actions group whenever ANY response was streaming. Every message's buttons
  // unmounted at once, so if the user had one focused — very likely, since Retry is
  // what starts a stream — focus fell back to `<body>` and their place in the
  // conversation was lost. The buttons now stay mounted and focusable; only the retry
  // ACTION is inert (`aria-disabled`, which unlike `disabled` keeps the node in the
  // tab order and keeps focus where it is).
  it('keeps the actions mounted and focusable while streaming', () => {
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
    };
    mockIsStreaming = true;
    render(<StudioMessageActions messageId="assistant-1" />);

    const retryButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip,
    });
    expect(retryButton.getAttribute('aria-disabled')).to.equal('true');
    expect(retryButton.hasAttribute('disabled')).to.equal(false);

    retryButton.focus();
    expect(document.activeElement).to.equal(retryButton);
  });

  it('does not regenerate while a response is streaming', () => {
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
    };
    mockIsStreaming = true;
    render(<StudioMessageActions messageId="assistant-1" />);

    fireEvent.click(
      screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
    );

    expect(regenerateSpy).not.toHaveBeenCalled();
  });

  it('renders nothing when the message does not exist', () => {
    mockMessage = null;
    const { container } = render(<StudioMessageActions messageId="gone" />);
    expect(container.firstChild).to.equal(null);
  });

  // The state-based `isRegenerating` guard cannot see two clicks dispatched before
  // React re-renders (a real double-click, or a held Enter key): both read the stale
  // `false`. The synchronous ref guard can. Batching both clicks inside ONE `act()` is
  // what removes the re-render between them — the existing three-click test above
  // deliberately does the opposite.
  it('drops a second retry click dispatched in the same tick', async () => {
    let resolveRegenerate: () => void = () => {};
    regenerateSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveRegenerate = resolve;
        }),
    );
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    };
    render(<StudioMessageActions messageId="assistant-1" />);
    const retryButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip,
    });

    act(() => {
      retryButton.click();
      retryButton.click();
    });

    expect(regenerateSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRegenerate();
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  // Regression coverage: a rejected `regenerate` promise must not surface as an
  // unhandled promise rejection, and the `isRegenerating` in-flight guard must
  // still be reset so the button isn't stuck disabled forever.
  it('resets isRegenerating and does not throw when regenerate rejects', async () => {
    regenerateSpy.mockRejectedValue(new Error('boom'));
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    };
    render(<StudioMessageActions messageId="assistant-1" />);
    const retryButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip,
    });

    fireEvent.click(retryButton);
    // A real macrotask flush (rather than a fixed number of `Promise.resolve()`
    // hops) so this isn't sensitive to exactly how many microtask ticks the
    // try/catch/finally wrapping takes to settle.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    // The guard was reset (button re-enabled), proving `finally` ran despite the
    // rejection, and a second retry is allowed again.
    fireEvent.click(retryButton);
    expect(regenerateSpy).toHaveBeenCalledTimes(2);
    // Flush the second click's rejection handling too, so its state update
    // doesn't land after this test has already returned.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  });

  // ── Retry must not re-apply the failed turn's mutations (finding M14) ────────
  //
  // "add a revenue chart and a KPI" → the chart mutation is applied → the connection
  // drops → Retry replays the whole turn server-side with fresh ids → two revenue
  // charts. The ledger records what each turn applied so Retry can revert it first.
  describe('double-apply guard', () => {
    interface FakeDoc {
      widgets: string[];
    }

    function makeControllerWithDoc() {
      let state = { doc: { widgets: [] as string[] } };
      return {
        getState: () => state as any,
        setState: vi.fn((next: any) => {
          state = next;
        }),
        currentDoc: () => state.doc as FakeDoc,
        applyMutation(widget: string) {
          state = { ...state, doc: { widgets: [...state.doc.widgets, widget] } };
          return state.doc;
        },
      };
    }

    function renderWithLedger(ledger: StudioChatTurnMutationLedger) {
      return render(
        <StudioChatTurnMutationContext.Provider value={ledger}>
          <StudioMessageActions messageId="assistant-1" />
        </StudioChatTurnMutationContext.Provider>,
      );
    }

    beforeEach(() => {
      mockMessage = {
        id: 'assistant-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'added the chart' }],
      };
    });

    it("reverts the failed turn's applied mutations before replaying it", async () => {
      const controller = makeControllerWithDoc();
      const ledger = createChatTurnMutationLedger(controller as any);
      const docBefore = controller.currentDoc();
      const docAfter = controller.applyMutation('revenue-chart');
      ledger.record('assistant-1', docBefore as any, docAfter as any);

      renderWithLedger(ledger);
      fireEvent.click(
        screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      // The half-applied edit is gone, so the replay's own `add_widget` lands once.
      expect(controller.currentDoc().widgets).to.deep.equal([]);
      expect(regenerateSpy).toHaveBeenCalledTimes(1);
    });

    it('reverts at most once, however many times the message is retried', async () => {
      const controller = makeControllerWithDoc();
      const ledger = createChatTurnMutationLedger(controller as any);
      const docBefore = controller.currentDoc();
      ledger.record('assistant-1', docBefore as any, controller.applyMutation('chart') as any);

      renderWithLedger(ledger);
      const retryButton = screen.getByRole('button', {
        name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip,
      });

      fireEvent.click(retryButton);
      await act(async () => {
        await Promise.resolve();
      });
      // The replayed turn adds its own widget, which this message's ledger entry
      // knows nothing about.
      controller.applyMutation('chart-from-replay');
      fireEvent.click(retryButton);
      await act(async () => {
        await Promise.resolve();
      });

      expect(controller.currentDoc().widgets).to.deep.equal(['chart-from-replay']);
      expect(ledger.has('assistant-1')).to.equal(false);
    });

    it('does not revert when the document changed after the failed turn', async () => {
      // A user edit (or an undo, or a later AI turn) landed in between. Restoring the
      // snapshot would silently discard it — worse than a duplicate widget.
      const controller = makeControllerWithDoc();
      const ledger = createChatTurnMutationLedger(controller as any);
      const docBefore = controller.currentDoc();
      ledger.record('assistant-1', docBefore as any, controller.applyMutation('chart') as any);
      controller.applyMutation('widget-the-user-added');

      renderWithLedger(ledger);
      fireEvent.click(
        screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(controller.currentDoc().widgets).to.deep.equal(['chart', 'widget-the-user-added']);
      expect(controller.setState).not.toHaveBeenCalled();
      // The retry itself still goes ahead.
      expect(regenerateSpy).toHaveBeenCalledTimes(1);
    });

    it('retries normally when the turn applied no mutations at all', async () => {
      const controller = makeControllerWithDoc();
      const ledger = createChatTurnMutationLedger(controller as any);

      renderWithLedger(ledger);
      fireEvent.click(
        screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
      );
      await act(async () => {
        await Promise.resolve();
      });

      expect(controller.setState).not.toHaveBeenCalled();
      expect(regenerateSpy).toHaveBeenCalledTimes(1);
    });
  });

  // Regression coverage: a SYNCHRONOUS throw from `regenerate` (before it ever
  // returns a promise) must not bypass the guard reset either.
  it('resets isRegenerating and does not throw when regenerate throws synchronously', async () => {
    regenerateSpy.mockImplementation(() => {
      throw new Error('sync boom');
    });
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    };
    render(<StudioMessageActions messageId="assistant-1" />);
    const retryButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip,
    });

    fireEvent.click(retryButton);
    // A real macrotask flush (rather than a fixed number of `Promise.resolve()`
    // hops) so this isn't sensitive to exactly how many microtask ticks the
    // try/catch/finally wrapping takes to settle.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });

    fireEvent.click(retryButton);
    expect(regenerateSpy).toHaveBeenCalledTimes(2);
    // Flush the second click's error handling too, so its state update doesn't
    // land after this test has already returned.
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  });
});
