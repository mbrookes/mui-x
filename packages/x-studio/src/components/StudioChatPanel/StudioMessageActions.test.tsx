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
import { createRenderer, screen, fireEvent } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { StudioMessageActions } from './StudioMessageActions';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const regenerateSpy = vi.fn();
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
    sendMessageSpy.mockClear();
    mockIsStreaming = false;
  });

  it('regenerates the assistant reply in place on retry (regression: 2.10)', () => {
    mockMessage = {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'answer' }],
    };
    render(<StudioMessageActions messageId="assistant-1" />);

    fireEvent.click(
      screen.getByRole('button', { name: DEFAULT_STUDIO_LOCALE_TEXT.chatMessageRetryTooltip }),
    );

    // Regenerate is targeted at THIS assistant message; sendMessage is never used
    // (using it would append a duplicate user turn + answer).
    expect(regenerateSpy).toHaveBeenCalledTimes(1);
    expect(regenerateSpy).toHaveBeenCalledWith('assistant-1');
    expect(sendMessageSpy).not.toHaveBeenCalled();
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
});
