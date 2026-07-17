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
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { StudioMessageActions } from './StudioMessageActions';

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

  it('renders nothing while streaming', () => {
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'partial' }],
    };
    mockIsStreaming = true;
    const { container } = render(<StudioMessageActions messageId="assistant-1" />);
    expect(container.firstChild).to.equal(null);
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
