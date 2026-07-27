import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@mui/internal-test-utils';
import { useChatVoiceInput } from './useChatVoiceInput';

// ── Minimal SpeechRecognition mock ────────────────────────────────────────────
// Mirrors the mock used by `useSpeechRecognition.test.ts` so we can drive
// recognition events through the composed `useChatVoiceInput` hook.

let mockInstance: MockSpeechRecognition;

class MockSpeechRecognition {
  continuous = false;

  interimResults = false;

  lang = '';

  onresult: ((event: MockSpeechRecognitionEvent) => void) | null = null;

  onerror: (() => void) | null = null;

  onend: (() => void) | null = null;

  startSpy = vi.fn();

  stopSpy = vi.fn();

  constructor() {
    // eslint-disable-next-line consistent-this -- intentional: expose `this` to the test scope
    mockInstance = this;
  }

  start() {
    this.startSpy();
  }

  stop() {
    this.stopSpy();
  }

  /** Helper: emit a fake onresult event from tests. */
  emitResult(transcript: string) {
    this.onresult?.({
      results: [{ 0: { transcript }, length: 1 }],
      length: 1,
    } as unknown as MockSpeechRecognitionEvent);
  }

  /** Helper: fire the onend handler (simulates browser session end). */
  emitEnd() {
    this.onend?.();
  }
}

type MockSpeechRecognitionEvent = {
  results: Array<{ 0: { transcript: string }; length: number }> & { length: number };
};

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
});

afterEach(() => {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useChatVoiceInput', () => {
  it('appends the live transcript to the pre-voice base text while listening', () => {
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleComposerValueChange('Hi');
    });
    act(() => {
      result.current.handleToggleVoice(); // start listening
    });
    act(() => {
      mockInstance.emitResult('there');
    });

    expect(result.current.composerValue).toBe('Hi there');
  });

  it('preserves the pre-voice base text when the user toggles the mic off (regression: 1.1)', () => {
    // "Hi" → speak "there" → composer "Hi there" → mic off → must stay "Hi there".
    // The removed "sync once more on stop" effect used to rebuild the composer from
    // the transcript alone (base ref already cleared), collapsing it to "there".
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleComposerValueChange('Hi');
    });
    act(() => {
      result.current.handleToggleVoice(); // start
    });
    act(() => {
      mockInstance.emitResult('there');
    });
    expect(result.current.composerValue).toBe('Hi there');

    act(() => {
      result.current.handleToggleVoice(); // user toggles mic off
    });

    expect(result.current.isListening).toBe(false);
    expect(result.current.composerValue).toBe('Hi there');
  });

  it('preserves typed text when the user types while listening (regression: 1.1)', () => {
    // Typing while listening stops voice and adopts the typed text. The removed
    // effect used to overwrite that typed text with the stale finalised transcript.
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleToggleVoice(); // start
    });
    act(() => {
      mockInstance.emitResult('hello world');
    });
    expect(result.current.composerValue).toBe('hello world');

    act(() => {
      // User edits the composer manually — this stops voice and adopts the edit.
      result.current.handleComposerValueChange('my typed text');
    });

    expect(result.current.isListening).toBe(false);
    expect(result.current.composerValue).toBe('my typed text');
    expect(mockInstance.stopSpy).toHaveBeenCalled();
  });

  it('does not leak a stale transcript into a later listen session', () => {
    // After a first session leaves "there" in the transcript, starting a new
    // session must reset it so the second session builds only from its own speech.
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleToggleVoice(); // start session 1
    });
    act(() => {
      mockInstance.emitResult('there');
    });
    act(() => {
      result.current.handleToggleVoice(); // stop session 1
    });
    expect(result.current.composerValue).toBe('there');

    act(() => {
      result.current.handleToggleVoice(); // start session 2 (base = "there")
    });
    act(() => {
      mockInstance.emitResult('again');
    });

    // Session 2 base is the retained "there"; the stale transcript was reset so it
    // does not double up.
    expect(result.current.composerValue).toBe('there again');
  });

  // ── Dictation language (regression: 3.15) ──────────────────────────────────
  //
  // `useSpeechRecognition` has always accepted a `lang`, but nothing ever passed one,
  // so the whole mechanism was dead and dictation always used the browser/OS default —
  // a French dashboard transcribing French speech as English words.
  describe('dictation language', () => {
    afterEach(() => {
      document.documentElement.removeAttribute('lang');
    });

    it("follows the document's <html lang>", () => {
      document.documentElement.lang = 'fr-FR';
      const { result } = renderHook(() => useChatVoiceInput());

      act(() => {
        result.current.handleToggleVoice();
      });

      expect(mockInstance.lang).to.equal('fr-FR');
    });

    it('prefers an explicit lang argument over the document language', () => {
      document.documentElement.lang = 'fr-FR';
      const { result } = renderHook(() => useChatVoiceInput('de-DE'));

      act(() => {
        result.current.handleToggleVoice();
      });

      expect(mockInstance.lang).to.equal('de-DE');
    });

    it('leaves the browser default when no language is available', () => {
      const { result } = renderHook(() => useChatVoiceInput());

      act(() => {
        result.current.handleToggleVoice();
      });

      expect(mockInstance.lang).to.equal('');
    });
  });

  // ── Programmatic composer writes must not stop dictation (regression: 3.15) ──
  //
  // `ChatBox` reports EVERY composer-store write back through `onComposerValueChange`,
  // including Studio's own. An auto-submitted widget insight sets the composer text and
  // the send pipeline then clears it — two "changes" the hook used to read as the user
  // typing, silently killing the microphone mid-sentence with no visible cause.
  it('does not stop listening for a programmatic composer change', () => {
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleToggleVoice(); // start
    });
    act(() => {
      mockInstance.emitResult('half a sentence');
    });

    act(() => {
      // What `AutoSubmitTrigger` does: set the auto-submitted text, then the send
      // pipeline clears the composer.
      result.current.runProgrammaticComposerChange(() => {
        result.current.handleComposerValueChange('Analyse the revenue widget');
        result.current.handleComposerValueChange('');
      });
    });

    expect(result.current.isListening).to.equal(true);
    expect(mockInstance.stopSpy).not.toHaveBeenCalled();

    // Dictation carries on and re-populates the composer with the full utterance.
    act(() => {
      mockInstance.emitResult('half a sentence and the rest');
    });
    expect(result.current.composerValue).to.equal('half a sentence and the rest');
  });

  it('still stops listening for a real user edit after a programmatic one', () => {
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleToggleVoice();
    });
    act(() => {
      result.current.runProgrammaticComposerChange(() => {
        result.current.handleComposerValueChange('auto');
      });
    });
    act(() => {
      result.current.handleComposerValueChange('typed by hand');
    });

    expect(result.current.isListening).to.equal(false);
    expect(result.current.composerValue).to.equal('typed by hand');
  });

  it('keeps the composer value when the browser auto-ends the session (onend)', () => {
    const { result } = renderHook(() => useChatVoiceInput());

    act(() => {
      result.current.handleToggleVoice(); // start
    });
    act(() => {
      mockInstance.emitResult('final words');
    });
    act(() => {
      mockInstance.emitEnd(); // browser-initiated auto-end
    });

    expect(result.current.isListening).toBe(false);
    expect(result.current.composerValue).toBe('final words');
  });
});
