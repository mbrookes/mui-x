import * as React from 'react';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it } from 'vitest';
import type { ChatAdapter } from '../../adapters/chatAdapter';
import type { ChatMessage } from '../../types/chat-entities';
import { ChatRoot } from '../../chat/ChatRoot';
import {
  getDefaultMessagePartRenderer,
  renderDefaultDataPart,
  renderDefaultDynamicToolPart,
  renderDefaultFilePart,
  renderDefaultReasoningPart,
  renderDefaultSourceDocumentPart,
  renderDefaultSourceUrlPart,
  renderDefaultStepStartPart,
  renderDefaultTextPart,
  renderDefaultToolPart,
} from '../defaultMessagePartRenderers';
import { MessageContent } from '../MessageContent';
import { MessageRoot } from '../MessageRoot';

const { render } = createRenderer();

function createAdapter(): ChatAdapter {
  return {
    async sendMessage() {
      return new ReadableStream({
        start(controller) {
          controller.close();
        },
      });
    },
  };
}

function renderWithMessage(message: ChatMessage) {
  return render(
    <ChatRoot adapter={createAdapter()} initialMessages={[message]}>
      <MessageRoot messageId={message.id}>
        <MessageContent data-testid="message-content" />
      </MessageRoot>
    </ChatRoot>,
  );
}

describe('ReasoningPart', () => {
  it('renders <details> with summary and text', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'Some chain of thought' }],
    });

    expect(screen.getByText('Reasoning')).not.to.equal(null);
    expect(screen.getByText('Some chain of thought')).not.to.equal(null);
  });

  it('opens when streaming', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      status: 'streaming',
      parts: [{ type: 'reasoning', text: 'Some reasoning', state: 'streaming' }],
    });

    // Default streaming label is "Thinking…"
    expect(screen.getByText('Thinking…')).not.to.equal(null);
    // The details element should be open when streaming
    const details = screen.getByText('Thinking…').closest('details');

    expect(details).not.to.equal(null);
    expect(details!.hasAttribute('open')).to.equal(true);
  });

  it('uses locale label for streaming vs done', () => {
    render(
      <ChatRoot
        adapter={createAdapter()}
        initialMessages={[
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'reasoning', text: 'Done thinking' }],
          },
        ]}
        localeText={{ messageReasoningLabel: 'Denken' }}
      >
        <MessageRoot messageId="m1">
          <MessageContent />
        </MessageRoot>
      </ChatRoot>,
    );

    expect(screen.getByText('Denken')).not.to.equal(null);
  });

  it('supports custom slots', () => {
    function CustomSummary(props: React.HTMLAttributes<HTMLElement> & { ownerState?: any }) {
      const { ownerState, ...other } = props;

      return <summary data-testid="custom-summary" {...other} />;
    }

    render(
      <ChatRoot
        adapter={createAdapter()}
        initialMessages={[
          {
            id: 'm1',
            role: 'assistant',
            parts: [{ type: 'reasoning', text: 'Think' }],
          },
        ]}
        partRenderers={{
          reasoning: (rendererProps) => (
            <details>
              <CustomSummary>{rendererProps.part.text}</CustomSummary>
            </details>
          ),
        }}
      >
        <MessageRoot messageId="m1">
          <MessageContent />
        </MessageRoot>
      </ChatRoot>,
    );

    expect(screen.getByTestId('custom-summary')).not.to.equal(null);
  });
});

describe('ToolPart sectionSummary slot', () => {
  it('passes summaryLabel and previewValue through ownerState to a custom sectionSummary', () => {
    let receivedOwnerState: any = null;

    function CustomSectionSummary(props: React.HTMLAttributes<HTMLElement> & { ownerState?: any }) {
      const { ownerState, children, ...other } = props;
      receivedOwnerState = ownerState;
      return (
        <strong data-testid="custom-section-summary" {...other}>
          {children}
        </strong>
      );
    }

    render(
      <ChatRoot
        adapter={createAdapter()}
        initialMessages={[
          {
            id: 'm1',
            role: 'assistant',
            parts: [
              {
                type: 'tool',
                toolInvocation: {
                  toolCallId: 'tc1',
                  toolName: 'search',
                  state: 'output-available',
                  input: { query: 'hello' },
                  output: { results: ['world'] },
                },
              },
            ],
          },
        ]}
      >
        <MessageRoot messageId="m1">
          <MessageContent
            partProps={{
              tool: {
                slots: {
                  sectionSummary: CustomSectionSummary,
                },
              },
            }}
          />
        </MessageRoot>
      </ChatRoot>,
    );

    expect(screen.getAllByTestId('custom-section-summary').length).to.equal(2);
    expect(receivedOwnerState).not.to.equal(null);
    expect(receivedOwnerState.summaryLabel).to.be.a('string');
    expect(receivedOwnerState.previewValue).to.be.a('string');
  });
});

// ── Approval request details (`reason` / `effects`) ──────────────────────────
//
// An approve/deny prompt that shows only the tool name and its arguments asks a human
// to authorize an operation whose impact they cannot see. `reason` (the backend's
// stated justification) is a plain string, so `ToolPart` renders it itself; `effects`
// is domain-specific and opaque to this package, so it reaches the screen only through
// the optional `approvalDetails` slot a host supplies.

describe('ToolPart approval request details', () => {
  function renderApproval(
    approvalRequest: Record<string, unknown> | undefined,
    slots?: Record<string, React.ElementType>,
    // The state defaults to the pending one, which is the only state the fixtures used to be
    // able to express — and so the only state the display copy was ever checked in.
    state: string = 'approval-requested',
  ) {
    return render(
      <ChatRoot
        adapter={createAdapter()}
        initialMessages={[
          {
            id: 'm1',
            role: 'assistant',
            parts: [
              {
                type: 'tool',
                toolInvocation: {
                  toolCallId: 'tc1',
                  toolName: 'search',
                  state,
                  input: { query: 'hello' },
                  approvalRequest,
                } as any,
              },
            ],
          },
        ]}
      >
        <MessageRoot messageId="m1">
          <MessageContent partProps={{ tool: { slots } }} />
        </MessageRoot>
      </ChatRoot>,
    );
  }

  // The card renders what the BACKEND resolved while the human is being asked, not what the
  // model sent. `toolInvocation.input` is the field a producer overwrites with the model's own
  // arguments so a replay resends what the model said — and with one field for both, that
  // re-assert put the model's OWN chosen labels in the section directly above the Approve
  // button, with the backend-resolved summary beside them and no cue which was which.
  it('shows the backend display copy, not the model arguments, above the approve button', () => {
    renderApproval({
      displayInput: { widgetTitle: 'Q4 Revenue — Board Deck' },
    });

    expect(screen.getByText(/Q4 Revenue/)).not.to.equal(null);
    // `input` is still the model's own, for the replay — it is just not what is drawn here.
    expect(screen.queryByText(/hello/)).to.equal(null);
  });

  // …and it keeps showing it AFTER the decision. `approvalRequest` survives every transition
  // out of `approval-requested`, and a producer re-asserts the model's own arguments over
  // `input` the moment the gated call settles — approved, denied or timed out all arrive the
  // same way. Gating the display copy on the pending state therefore made the card silently
  // revert to the model's chosen labels once the human had answered, with the backend-verified
  // copy sitting unrendered on the same part.
  //
  // The card is the RECORD of what the human approved or denied, not just the prompt for the
  // decision, so it renders the verified copy in every state the input section is shown in.
  // `input` remains the model's own arguments for replay fidelity — that is what the field is
  // for; it is simply never the field this section draws when a backend copy exists.
  it.each(['approval-responded', 'output-available', 'output-error'])(
    'keeps showing the backend display copy after the call settles (%s)',
    (state) => {
      renderApproval({ displayInput: { widgetTitle: 'Q4 Revenue — Board Deck' } }, undefined, state);

      expect(screen.getByText(/Q4 Revenue/)).not.to.equal(null);
      expect(screen.queryByText(/hello/)).to.equal(null);
    },
  );

  it('falls back to the model arguments when the backend sent no display copy', () => {
    // A producer that does not use `displayInput` sees exactly the previous behaviour.
    renderApproval({ reason: 'why' });
    expect(screen.getByText(/hello/)).not.to.equal(null);
  });

  it('renders the request reason above the approve/deny buttons', () => {
    renderApproval({ reason: 'this exceeds the daily mutation budget' });
    expect(screen.getByText('this exceeds the daily mutation budget')).not.to.equal(null);
  });

  it('does not mount the reason slot for an empty or missing reason', () => {
    function Reason(props: React.HTMLAttributes<HTMLDivElement>) {
      return <div data-testid="approval-reason" {...props} />;
    }
    renderApproval({ reason: '' }, { approvalReason: Reason });
    expect(screen.queryByTestId('approval-reason')).to.equal(null);

    renderApproval(undefined, { approvalReason: Reason });
    expect(screen.queryByTestId('approval-reason')).to.equal(null);
  });

  it('mounts the approvalDetails slot with effects on ownerState', () => {
    let received: any = null;
    function Details(props: React.HTMLAttributes<HTMLDivElement> & { ownerState?: any }) {
      const { ownerState, ...other } = props;
      received = ownerState;
      return <div data-testid="approval-details" {...other} />;
    }

    renderApproval({ effects: { willRemoveWidgets: [{ id: 'w1', title: 'W1' }] } }, {
      approvalDetails: Details,
    });

    expect(screen.getByTestId('approval-details')).not.to.equal(null);
    expect(received.approvalRequest.effects).to.deep.equal({
      willRemoveWidgets: [{ id: 'w1', title: 'W1' }],
    });
  });

  it('does not mount approvalDetails when there are no effects', () => {
    function Details(props: React.HTMLAttributes<HTMLDivElement>) {
      return <div data-testid="approval-details" {...props} />;
    }
    renderApproval({ reason: 'why' }, { approvalDetails: Details });
    expect(screen.queryByTestId('approval-details')).to.equal(null);
  });
});

describe('FilePart', () => {
  it('renders <img> inside link for image mediaType', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'file',
          mediaType: 'image/png',
          url: 'https://example.com/img.png',
          filename: 'img.png',
        },
      ],
    });

    const img = screen.getByAltText('img.png');

    expect(img).not.to.equal(null);
    expect(img).to.have.attribute('src', 'https://example.com/img.png');
  });

  it('renders file icon + filename for non-image', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          url: 'https://example.com/doc.pdf',
          filename: 'doc.pdf',
        },
      ],
    });

    expect(screen.getByText('doc.pdf')).not.to.equal(null);
  });

  it('falls back to URL when no filename', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'file',
          mediaType: 'application/pdf',
          url: 'https://example.com/doc.pdf',
        },
      ],
    });

    expect(screen.getByText('https://example.com/doc.pdf')).not.to.equal(null);
  });
});

describe('SourceUrlPart', () => {
  it('renders <a> with target="_blank", rel="noreferrer noopener"', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'source-url',
          sourceId: 's1',
          url: 'https://mui.com',
          title: 'MUI Docs',
        },
      ],
    });

    const link = screen.getByText('MUI Docs');

    expect(link.closest('a')).to.have.attribute('target', '_blank');
    expect(link.closest('a')).to.have.attribute('rel', 'noreferrer noopener');
  });

  it('uses title as link text, falls back to URL', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'source-url',
          sourceId: 's1',
          url: 'https://mui.com/x',
        },
      ],
    });

    expect(screen.getByText('https://mui.com/x')).not.to.equal(null);
  });
});

describe('SourceDocumentPart', () => {
  it('renders title when present', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'source-document',
          sourceId: 'd1',
          title: 'Doc Title',
          text: 'Doc text',
        },
      ],
    });

    expect(screen.getByText('Doc Title')).not.to.equal(null);
  });

  it('renders text when present', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'source-document',
          sourceId: 'd1',
          text: 'Some excerpt',
        },
      ],
    });

    expect(screen.getByText('Some excerpt')).not.to.equal(null);
  });

  it('renders empty root when neither title nor text', () => {
    renderWithMessage({
      id: 'm1',
      role: 'assistant',
      parts: [
        {
          type: 'source-document',
          sourceId: 'd1',
        },
      ],
    });

    // Should not crash; the root is still rendered
    expect(screen.getByTestId('message-content').textContent).to.equal('');
  });
});

describe('defaultMessagePartRenderers', () => {
  it('getDefaultMessagePartRenderer returns correct renderer for text', () => {
    expect(getDefaultMessagePartRenderer({ type: 'text', text: 'hi' })).toBe(renderDefaultTextPart);
  });

  it('getDefaultMessagePartRenderer returns correct renderer for reasoning', () => {
    expect(getDefaultMessagePartRenderer({ type: 'reasoning', text: 'x' })).toBe(
      renderDefaultReasoningPart,
    );
  });

  it('getDefaultMessagePartRenderer returns correct renderer for tool', () => {
    expect(
      getDefaultMessagePartRenderer({
        type: 'tool',
        toolInvocation: {
          toolCallId: 't1',
          toolName: 'search',
          state: 'output-available',
          input: { query: '' },
          output: { results: [] },
        },
      }),
    ).toBe(renderDefaultToolPart);
  });

  it('getDefaultMessagePartRenderer returns correct renderer for dynamic-tool', () => {
    expect(
      getDefaultMessagePartRenderer({
        type: 'dynamic-tool',
        toolInvocation: {
          toolCallId: 't1',
          toolName: 'search',
          state: 'output-available',
          input: { query: '' },
          output: { results: [] },
        },
      }),
    ).toBe(renderDefaultDynamicToolPart);
  });

  it('getDefaultMessagePartRenderer returns correct renderer for file', () => {
    expect(
      getDefaultMessagePartRenderer({
        type: 'file',
        mediaType: 'image/png',
        url: 'http://example.com/a.png',
      }),
    ).toBe(renderDefaultFilePart);
  });

  it('getDefaultMessagePartRenderer returns correct renderer for source-url', () => {
    expect(
      getDefaultMessagePartRenderer({ type: 'source-url', sourceId: 's1', url: 'http://x.com' }),
    ).toBe(renderDefaultSourceUrlPart);
  });

  it('getDefaultMessagePartRenderer returns correct renderer for source-document', () => {
    expect(getDefaultMessagePartRenderer({ type: 'source-document', sourceId: 'd1' })).toBe(
      renderDefaultSourceDocumentPart,
    );
  });

  it('getDefaultMessagePartRenderer returns correct renderer for step-start', () => {
    expect(getDefaultMessagePartRenderer({ type: 'step-start' })).toBe(renderDefaultStepStartPart);
  });

  it('getDefaultMessagePartRenderer returns data renderer for data-* types', () => {
    expect(
      getDefaultMessagePartRenderer({
        type: 'data-weather',
        data: { temp: 20 },
      } as any),
    ).toBe(renderDefaultDataPart);
  });

  it('getDefaultMessagePartRenderer returns null for unknown types', () => {
    expect(getDefaultMessagePartRenderer({ type: 'totally-unknown' } as any)).to.equal(null);
  });
});
