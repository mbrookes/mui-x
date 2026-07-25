import { describe, it, expect } from 'vitest';
import { STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import { STUDIO_TOOL_ICONS, STUDIO_TOOL_LABEL_KEYS } from './chatToolRenderers';
import { lookup } from '../../utils/safeLookup';

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

/**
 * `toolName` on a tool part is whatever the model emitted — fully LLM-controlled. A bare
 * `STUDIO_TOOL_LABEL_KEYS[toolName]` on `"constructor"` resolves the inherited `Object`
 * constructor: `localeKey !== undefined` passes, and the tool-card title renders blank (or
 * React throws "Functions are not valid as a React child"). `StudioToolTitle` indexes both
 * maps through `utils/safeLookup`'s `lookup` instead.
 */
describe('chat tool-card maps reject prototype-chain tool names', () => {
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

  PROTO_KEYS.forEach((key) => {
    it(`"${key}" is not an own key of either map and resolves to undefined`, () => {
      expect(Object.hasOwn(STUDIO_TOOL_LABEL_KEYS, key)).toBe(false);
      expect(Object.hasOwn(STUDIO_TOOL_ICONS, key)).toBe(false);
      expect(lookup(STUDIO_TOOL_LABEL_KEYS as Record<string, unknown>, key)).toBeUndefined();
      expect(lookup(STUDIO_TOOL_ICONS as Record<string, unknown>, key)).toBeUndefined();
      // The bug: the bare index resolves a truthy inherited function instead.
      expect(typeof (STUDIO_TOOL_LABEL_KEYS as Record<string, unknown>)[key]).toBe('function');
    });
  });
});
