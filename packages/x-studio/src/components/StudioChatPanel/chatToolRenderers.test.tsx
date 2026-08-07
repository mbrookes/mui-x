import * as React from 'react';
import { describe, it, expect } from 'vitest';
import { createRenderer, screen } from '@mui/internal-test-utils';
import { STUDIO_AI_TOOL_REGISTRY } from '@mui/x-studio-schema';
import { DEFAULT_STUDIO_LOCALE_TEXT } from '@mui/x-studio-core/engine';
import {
  STUDIO_TOOL_ICONS,
  STUDIO_TOOL_LABEL_KEYS,
  StudioApprovalEffects,
  StudioToolTitle,
} from './chatToolRenderers';

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

/**
 * The `approvalDetails` slot: renders the server-computed `effects` summary — which
 * widgets/pages/filters the pending call will delete, which it will orphan, how many it
 * will update — beside the approve/deny buttons, so a human approves against real
 * titles instead of an opaque id matrix.
 *
 * `ownerState.approvalRequest.effects` is typed `unknown` in `@mui/x-chat-headless`
 * deliberately: it arrived over the network. `studioBackendAdapter` already sanitized it
 * on the way in, and this component narrows again — the malformed-payload tests below
 * are what prove the second guard is real rather than a cast, and they are the reason a
 * non-string title can never reach a React child position here.
 *
 * No provider is mounted on purpose: `useStudioLocaleText` falls back to
 * `DEFAULT_STUDIO_LOCALE_TEXT`, which is the bundle these assertions read.
 */
describe('StudioApprovalEffects', () => {
  const { render } = createRenderer();

  function renderEffects(effects: unknown) {
    return render(
      <StudioApprovalEffects
        ownerState={{ approvalRequest: { effects } } as any}
        data-testid="effects"
      />,
    );
  }

  it('renders each impact group with the entity titles the server resolved', () => {
    renderEffects({
      willRemoveWidgets: [
        { id: 'w1', title: 'Revenue by region' },
        { id: 'w2', title: 'Orders' },
      ],
      willRemovePages: [{ id: 'p1', title: 'Overview' }],
      willOrphanWidgets: [{ id: 'w3', title: 'Churn' }],
      willRemoveFilters: ['f1'],
      updatedWidgetCount: 4,
    });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalWillRemoveWidgets);
    expect(text).to.contain('Revenue by region');
    expect(text).to.contain('Orders');
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalWillRemovePages);
    expect(text).to.contain('Overview');
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalWillOrphanWidgets);
    expect(text).to.contain('Churn');
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalWillRemoveFilters);
    expect(text).to.contain('f1');
    expect(text).to.contain(`${DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalUpdatedWidgetCount}: 4`);
  });

  it('omits a group the payload does not carry', () => {
    renderEffects({ willRemoveWidgets: [{ id: 'w1', title: 'W1' }] });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalWillRemoveWidgets);
    expect(text).not.to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalWillRemovePages);
    expect(text).not.to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalUpdatedWidgetCount);
  });

  it('renders nothing when there is no usable payload', () => {
    for (const payload of [undefined, null, 'a string', [], {}, { willRemoveWidgets: [] }]) {
      const { unmount } = renderEffects(payload);
      expect(screen.queryByTestId('effects')).to.equal(null);
      unmount();
    }
  });

  // A card whose impact summary the ADAPTER withheld (over its size limits, or past the
  // per-turn budget for them) used to render byte-identically to a card for a call with no
  // impact at all. Those two deserve opposite answers from the human holding the deny button,
  // so the withheld case is the one payload that renders even though it lists nothing.
  it('says so when the adapter withheld the impact summary', () => {
    renderEffects({ effectsWithheld: true });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalEffectsWithheld);
  });

  it('does not claim a summary was withheld when the payload simply had none', () => {
    // `{}` and an empty list are "this call removes nothing", not "the list did not fit".
    for (const payload of [{}, { willRemoveWidgets: [] }, { effectsWithheld: false }]) {
      const { unmount } = renderEffects(payload);
      expect(screen.queryByTestId('effects')).to.equal(null);
      unmount();
    }
  });

  // The same argument, on the field beside `effects` and on the same shared budget: "the
  // policy gave no reason" and "the reason did not fit" are opposite signals, and `reason`
  // had no marker at all until now.
  it('says so when the adapter withheld the policy reason', () => {
    renderEffects({ reasonWithheld: true });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalReasonWithheld);
  });

  it('does not claim a reason was withheld when the payload simply had none', () => {
    for (const payload of [{}, { reasonWithheld: false }]) {
      const { unmount } = renderEffects(payload);
      expect(screen.queryByTestId('effects')).to.equal(null);
      unmount();
    }
  });

  // `ToolPart` renders its "Input" section whenever `input !== undefined`, and the `{}` an
  // over-cap input degrades to IS defined — so without this the card is byte-identical to one
  // for a genuine no-argument call.
  it('says so when the adapter withheld the request details', () => {
    renderEffects({ inputWithheld: true });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalInputWithheld);
  });

  it('does not claim details were withheld when the payload simply had none', () => {
    for (const payload of [{}, { inputWithheld: false }]) {
      const { unmount } = renderEffects(payload);
      expect(screen.queryByTestId('effects')).to.equal(null);
      unmount();
    }
  });

  // `effects` is charged before `reason`, so a card can keep its whole impact list and lose
  // only its reason. Both must show.
  it('renders a real impact list and a withheld-reason marker together', () => {
    renderEffects({
      willRemovePages: [{ id: 'p1', title: 'Finance' }],
      reasonWithheld: true,
    });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain('Finance');
    expect(text).to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalReasonWithheld);
  });

  // The narrowing that matters: a non-string `title` (a number, an object, a function)
  // put straight into a React child position is a crash in a non-production build, and
  // this payload came off the wire. Entries that fail the guard are dropped, not coerced.
  it('drops malformed entries instead of rendering them', () => {
    renderEffects({
      willRemoveWidgets: [
        { id: 'w1', title: 'Real widget' },
        { id: 'w2', title: 42 },
        { id: 'w3' },
        { title: 'no id' },
        null,
        'not an entry',
      ],
      willRemoveFilters: ['f1', 7, { id: 'f2' }],
      updatedWidgetCount: 'lots',
    });

    const text = screen.getByTestId('effects').textContent ?? '';
    expect(text).to.contain('Real widget');
    expect(text).not.to.contain('42');
    expect(text).not.to.contain('no id');
    expect(text).to.contain('f1');
    expect(text).not.to.contain('7');
    // A non-numeric count is dropped rather than stringified into the summary.
    expect(text).not.to.contain(DEFAULT_STUDIO_LOCALE_TEXT.chatApprovalUpdatedWidgetCount);
  });
});
