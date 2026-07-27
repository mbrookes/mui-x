import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '../../internals/StudioUIConfigContext';
import { STUDIO_TOOL_ICONS, STUDIO_TOOL_LABEL_KEYS, StudioToolTitle } from './chatToolRenderers';

/**
 * Regression guard for architecture-review finding 2.28: the chat tool-card
 * icon/label maps had drifted from the AI tool registry (`list_pages` missing,
 * `get_current_date` a phantom entry for a tool that doesn't exist). Assert
 * both maps have exactly one entry per registered tool — no more, no less.
 *
 * (The maps are now typed `Record<StudioAIToolName, …>`, so a MISSING entry is a
 * compile error too. These tests still catch the other direction — a stale entry
 * for a tool since removed from the registry.)
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
 * React throws "Functions are not valid as a React child"). `StudioToolTitle` indexes the
 * map through `utils/safeLookup`'s `lookup` instead.
 *
 * These tests RENDER the component. Asserting on the maps alone cannot fail: they are plain
 * object literals, so `Object.hasOwn(map, 'constructor')` is `false` and
 * `typeof map.constructor === 'function'` is true of every object literal in JavaScript —
 * true no matter how (or whether) the component indexes them. Only rendering distinguishes
 * `lookup(map, name)` from `map[name]`.
 *
 * No provider is mounted on purpose: `useStudioLocaleText` falls back to
 * `DEFAULT_STUDIO_LOCALE_TEXT`, which is the bundle these assertions read.
 */
describe('StudioToolTitle', () => {
  const { render } = createRenderer();
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];

  it('renders the localized label for a real tool name', () => {
    render(
      <StudioToolTitle ownerState={{ toolName: 'add_widget' } as any} data-testid="title">
        add_widget
      </StudioToolTitle>,
    );

    expect(screen.getByTestId('title').textContent).to.equal(
      DEFAULT_STUDIO_LOCALE_TEXT.chatToolLabelAddWidget,
    );
  });

  PROTO_KEYS.forEach((key) => {
    it(`falls back to the default title for the prototype-chain tool name "${key}"`, () => {
      // With a bare bracket index this renders blank (the resolved `Object.prototype`
      // member is not a `StudioLocaleText` key, so `localeText[localeKey]` is undefined)
      // or throws "Functions are not valid as a React child" in a checked build.
      render(
        <StudioToolTitle ownerState={{ toolName: key } as any} data-testid="title">
          {key}
        </StudioToolTitle>,
      );

      expect(screen.getByTestId('title').textContent).to.equal(key);
    });
  });

  it('falls back to the default title for an unknown tool name', () => {
    render(
      <StudioToolTitle ownerState={{ toolName: 'not_a_real_tool' } as any} data-testid="title">
        not_a_real_tool
      </StudioToolTitle>,
    );

    expect(screen.getByTestId('title').textContent).to.equal('not_a_real_tool');
  });
});
