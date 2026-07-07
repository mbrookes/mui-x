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
import { createRenderer, screen } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createDefaultStudioState } from '../../models/stateTypes';
import type { StudioState } from '../../models';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
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

vi.mock('../../internals/StudioUIConfigContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../internals/StudioUIConfigContext')>();
  return {
    ...actual,
    useStudioLocaleText: () => DEFAULT_STUDIO_LOCALE_TEXT,
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
    expect(screen.getByPlaceholderText('How can I help?')).toBeDefined();
  });

  it('renders an overlay panel with a close button when overlay + onClose are set', () => {
    const onClose = vi.fn();
    render(<StudioChatPanel aiConfig={aiConfig} overlay open onClose={onClose} />);

    const closeButton = screen.getByRole('button', {
      name: DEFAULT_STUDIO_LOCALE_TEXT.aiAssistantCloseTooltip,
    });
    expect(closeButton).toBeDefined();
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
