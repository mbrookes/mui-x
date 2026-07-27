/**
 * Unit coverage for `AutoSubmitTrigger`'s consumption contract (finding M13).
 *
 * The two conditions that make `submit()` a silent no-op are both invisible from
 * outside `@mui/x-chat`: `store.state.isStreaming` can flip inside the macrotask the
 * submit is deferred by, and the send pipeline's `isSending` guard is a closure
 * variable that clears slightly AFTER `isStreaming` resets. Neither is reachable
 * through a full `<ChatBox>` render, so the headless hooks are faked here — that is
 * the only way to hold the component in each gap deliberately.
 */
import * as React from 'react';
import { createRenderer, act } from '@mui/internal-test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Fake chat store / composer ───────────────────────────────────────────────

interface FakeStore {
  state: { isStreaming: boolean; messageIds: string[] };
}

let store: FakeStore;
/** What a `submit()` call does in the current test: land a message, or silently no-op. */
let submitBehavior: () => void;
const setValueSpy = vi.fn();
const submitSpy = vi.fn(() => {
  submitBehavior();
  return Promise.resolve();
});

vi.mock('@mui/x-chat/headless', () => ({
  useChatStore: () => store,
  useChatComposer: () => ({
    setValue: setValueSpy,
    submit: submitSpy,
    isSubmitting: store.state.isStreaming,
  }),
}));

// Imported after the mock so the component binds to the fakes above.
// eslint-disable-next-line import/first
import { AutoSubmitTrigger, MAX_AUTO_SUBMIT_ATTEMPTS, type PendingAutoSubmit } from './autoSubmit';

function landsAMessage() {
  store.state = {
    ...store.state,
    messageIds: [...store.state.messageIds, `m-${store.state.messageIds.length}`],
  };
}

function silentlyNoOps() {
  // What the `isSending` gap looks like from here: the call returns, nothing happens.
}

const runProgrammatic = (fn: () => void) => fn();

async function flush(rounds = MAX_AUTO_SUBMIT_ATTEMPTS + 2) {
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}

describe('AutoSubmitTrigger', () => {
  const { render } = createRenderer();
  let consumed: number[];

  const onConsumed = (seq: number) => {
    consumed.push(seq);
  };
  const pending: PendingAutoSubmit[] = [{ text: 'Analyse this widget', seq: 1 }];

  beforeEach(() => {
    store = { state: { isStreaming: false, messageIds: [] } };
    submitBehavior = landsAMessage;
    submitSpy.mockClear();
    setValueSpy.mockClear();
    consumed = [];
  });

  it('submits the queued entry and consumes it once the message lands', async () => {
    render(
      <AutoSubmitTrigger
        pending={pending}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={runProgrammatic}
      />,
    );
    await flush(2);

    expect(setValueSpy).toHaveBeenCalledWith('Analyse this widget');
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(consumed).to.deep.equal([1]);
  });

  // THE regression: the entry used to be marked consumed unconditionally, right after
  // `submit()`. When the send pipeline refused (its `isSending` guard is still set from
  // the previous turn's trailing bookkeeping), the prompt vanished — no request, no
  // message, no error.
  it('does not consume the entry when submit() silently no-ops', async () => {
    submitBehavior = silentlyNoOps;

    render(
      <AutoSubmitTrigger
        pending={pending}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={runProgrammatic}
      />,
    );
    await flush();

    expect(submitSpy).toHaveBeenCalled();
    expect(consumed).to.deep.equal([]); // still queued for a later retry
  });

  it('retries on later macrotasks and consumes the entry once one lands', async () => {
    let calls = 0;
    submitBehavior = () => {
      calls += 1;
      if (calls >= 3) {
        landsAMessage();
      }
    };

    render(
      <AutoSubmitTrigger
        pending={pending}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={runProgrammatic}
      />,
    );
    await flush();

    expect(submitSpy).toHaveBeenCalledTimes(3);
    expect(consumed).to.deep.equal([1]);
  });

  it('gives up retrying after a bounded number of attempts, leaving the entry queued', async () => {
    submitBehavior = silentlyNoOps;

    render(
      <AutoSubmitTrigger
        pending={pending}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={runProgrammatic}
      />,
    );
    await flush(MAX_AUTO_SUBMIT_ATTEMPTS + 5);

    // Bounded — not an unbounded macrotask loop.
    expect(submitSpy).toHaveBeenCalledTimes(MAX_AUTO_SUBMIT_ATTEMPTS);
    expect(consumed).to.deep.equal([]);
  });

  // The other half of "re-check at the moment of the action": `isSubmitting` is a
  // render-time snapshot, and the submit is deliberately deferred by a macrotask, so a
  // stream can start inside that gap.
  it('does not submit when a stream starts between the effect and the deferred submit', async () => {
    render(
      <AutoSubmitTrigger
        pending={pending}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={runProgrammatic}
      />,
    );
    // Still inside the 0ms gap: flip the LIVE store flag without re-rendering, exactly
    // as another send would.
    store.state = { ...store.state, isStreaming: true };
    await flush();

    expect(submitSpy).not.toHaveBeenCalled();
    expect(consumed).to.deep.equal([]);
  });

  it('drops a blank entry rather than wedging the head of the queue', async () => {
    render(
      <AutoSubmitTrigger
        pending={[{ text: '   ', seq: 7 }]}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={runProgrammatic}
      />,
    );
    await flush(2);

    expect(submitSpy).not.toHaveBeenCalled();
    expect(consumed).to.deep.equal([7]);
  });

  it('marks its composer writes as programmatic so dictation is not torn down', async () => {
    const marks: string[] = [];
    render(
      <AutoSubmitTrigger
        pending={pending}
        onConsumed={onConsumed}
        runProgrammaticComposerChange={(fn) => {
          marks.push('enter');
          fn();
          marks.push('exit');
        }}
      />,
    );
    await flush(2);

    // Both the value write and the submit (which clears the composer) happen inside
    // the marked window — outside it, `useChatVoiceInput` reads them as user typing.
    expect(marks).to.deep.equal(['enter', 'exit']);
    expect(setValueSpy).toHaveBeenCalled();
    expect(submitSpy).toHaveBeenCalled();
  });
});
