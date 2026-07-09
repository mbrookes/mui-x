import { describe, it, expect } from 'vitest';
import { STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import { STUDIO_TOOL_ICONS, STUDIO_TOOL_LABEL_KEYS } from './chatToolRenderers';

/**
 * Regression guard for architecture-review finding 2.28: the chat tool-card
 * icon/label maps had drifted from the AI tool registry (`list_pages` missing,
 * `get_current_date` a phantom entry for a tool that doesn't exist). Assert
 * both maps have exactly one entry per registered tool — no more, no less.
 */
describe('chat tool-card registry parity', () => {
  const registryToolNames = Object.keys(STUDIO_AI_TOOL_REGISTRY).sort();

  it('STUDIO_TOOL_ICONS has exactly one entry per registered tool', () => {
    expect(Object.keys(STUDIO_TOOL_ICONS).sort()).toEqual(registryToolNames);
  });

  it('STUDIO_TOOL_LABEL_KEYS has exactly one entry per registered tool', () => {
    expect(Object.keys(STUDIO_TOOL_LABEL_KEYS).sort()).toEqual(registryToolNames);
  });
});
