import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@mui/internal-test-utils';
import { useSpeechRecognition } from './useSpeechRecognition';

// ── Minimal SpeechRecognition mock ────────────────────────────────────────────

// Captures the last-created instance so tests can drive events.
let mockInstance: MockSpeechRecognition;
// Every instance created during a test, oldest first. The stale-handler regression tests
// need to drive events on a SUPERSEDED instance, which `mockInstance` no longer points at.
const mockInstances: MockSpeechRecognition[] = [];

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
    // Capture the instance so tests can drive recognition events on the active mock.
    // eslint-disable-next-line consistent-this -- intentional: expose `this` to the test scope
    mockInstance = this;
    mockInstances.push(this);
  }

  start() {
    this.startSpy();
  }

  stop() {
    this.stopSpy();
  }

  /** Helper: emit a fake onresult event from tests */
  emitResult(transcript: string) {
    this.onresult?.({
      results: [{ 0: { transcript }, length: 1 }],
      length: 1,
    } as unknown as MockSpeechRecognitionEvent);
  }

  /** Helper: fire the onend handler (simulates browser session end) */
  emitEnd() {
    this.onend?.();
  }

  /** Helper: fire onerror */
  emitError() {
    this.onerror?.();
  }
}

type MockSpeechRecognitionEvent = {
  results: Array<{ 0: { transcript: string }; length: number }> & { length: number };
};

// ── Test setup ────────────────────────────────────────────────────────────────

beforeEach(() => {
  mockInstances.length = 0;
  (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = MockSpeechRecognition;
});

afterEach(() => {
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useSpeechRecognition', () => {
  it('reports isSupported: true when SpeechRecognition is available', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    expect(result.current.isSupported).toBe(true);
  });

  it('reports isSupported: false when SpeechRecognition is absent', () => {
    delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    const { result } = renderHook(() => useSpeechRecognition());
    expect(result.current.isSupported).toBe(false);
  });

  it('starts in not-listening state with empty transcript', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    expect(result.current.isListening).toBe(false);
    expect(result.current.transcript).toBe('');
  });

  it('sets isListening to true and calls recognition.start() when start() is invoked', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    expect(result.current.isListening).toBe(true);
    expect(mockInstance.startSpy).toHaveBeenCalledOnce();
  });

  it('sets continuous and interimResults on the recognition instance', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    expect(mockInstance.continuous).toBe(true);
    expect(mockInstance.interimResults).toBe(true);
  });

  it('accumulates transcript from onresult events', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    act(() => {
      mockInstance.emitResult('hello world');
    });
    expect(result.current.transcript).toBe('hello world');
  });

  it('calls recognition.stop() and sets isListening to false when stop() is called', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.stop();
    });
    expect(result.current.isListening).toBe(false);
    expect(mockInstance.stopSpy).toHaveBeenCalledOnce();
  });

  it('sets isListening to false when browser fires onend', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    act(() => {
      mockInstance.emitEnd();
    });
    expect(result.current.isListening).toBe(false);
  });

  it('sets isListening to false when browser fires onerror', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    act(() => {
      mockInstance.emitError();
    });
    expect(result.current.isListening).toBe(false);
  });

  it('resetTranscript clears the transcript without stopping recognition', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    act(() => {
      mockInstance.emitResult('some text');
    });
    act(() => {
      result.current.resetTranscript();
    });
    expect(result.current.transcript).toBe('');
    expect(result.current.isListening).toBe(true);
  });

  it('does nothing when start() is called while already listening', () => {
    const { result } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    act(() => {
      result.current.start(); // second call — should be a no-op
    });
    // Assert on the INSTANCE COUNT, not on `mockInstance.startSpy`. The mock
    // constructor reassigns `mockInstance` to the newest instance, so dropping the
    // `recognitionRef.current` early-return would construct a second recognition
    // object — leaving two microphones open — and `mockInstance` (now instance B)
    // would still report exactly one `start()` call. Only the instance count can
    // observe the guard.
    expect(mockInstances).toHaveLength(1);
    expect(mockInstances[0].startSpy).toHaveBeenCalledOnce();
  });

  it('stops recognition on unmount', () => {
    const { result, unmount } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    unmount();
    expect(mockInstance.stopSpy).toHaveBeenCalled();
  });

  // ── Stale-handler / device-leak regressions (H7) ────────────────────────────
  //
  // `recognition.stop()` is asynchronous, so toggling the mic off then on again (or
  // typing, which `useChatVoiceInput` turns into a `stopVoice()`) leaves instance A
  // winding down while instance B is already recording. A's handlers used to mutate the
  // shared hook state unconditionally, so A's late `onend` cleared the ref and flipped
  // `isListening` to false while B was still live — after which `stop()` (including the
  // unmount cleanup) no-op'd forever and the microphone stayed hot until page unload.
  describe('superseded instances', () => {
    function startStopStart() {
      const view = renderHook(() => useSpeechRecognition());
      act(() => {
        view.result.current.start();
      });
      act(() => {
        view.result.current.stop();
      });
      act(() => {
        view.result.current.start();
      });
      return view;
    }

    it("ignores a superseded instance's late onend", () => {
      const { result } = startStopStart();
      expect(mockInstances).toHaveLength(2);
      const [instanceA] = mockInstances;

      act(() => {
        instanceA.emitEnd();
      });

      // B is still recording, so the hook must still report listening.
      expect(result.current.isListening).toBe(true);
    });

    it("ignores a superseded instance's late onerror", () => {
      const { result } = startStopStart();
      act(() => {
        mockInstances[0].emitError();
      });
      expect(result.current.isListening).toBe(true);
    });

    it("ignores a superseded instance's late onresult", () => {
      const { result } = startStopStart();
      act(() => {
        mockInstances[1].emitResult('from B');
      });
      act(() => {
        mockInstances[0].emitResult('from A');
      });
      expect(result.current.transcript).toBe('from B');
    });

    it('can still stop the live instance after a superseded one ends', () => {
      const { result } = startStopStart();
      const [instanceA, instanceB] = mockInstances;
      act(() => {
        instanceA.emitEnd();
      });

      act(() => {
        result.current.stop();
      });

      expect(instanceB.stopSpy).toHaveBeenCalled();
      expect(result.current.isListening).toBe(false);
    });

    it('stops every still-live instance on unmount, not just the current one', () => {
      const { result, unmount } = renderHook(() => useSpeechRecognition());
      act(() => {
        result.current.start();
      });
      act(() => {
        result.current.stop();
      });
      act(() => {
        result.current.start();
      });
      const [instanceA, instanceB] = mockInstances;
      // A was asked to stop but its `onend` never arrived — the browser still holds the mic.
      instanceA.stopSpy.mockClear();

      unmount();

      expect(instanceA.stopSpy).toHaveBeenCalled();
      expect(instanceB.stopSpy).toHaveBeenCalled();
    });

    it('does not re-stop an instance that already reported onend', () => {
      const { result, unmount } = renderHook(() => useSpeechRecognition());
      act(() => {
        result.current.start();
      });
      act(() => {
        mockInstance.emitEnd();
      });
      const [instanceA] = mockInstances;
      instanceA.stopSpy.mockClear();

      unmount();

      expect(instanceA.stopSpy).not.toHaveBeenCalled();
    });
  });

  // Regression coverage for finding 3.15: `recognition.lang` was never set, so
  // dictation always followed the browser/OS default instead of the app's active
  // locale (when the caller can supply one).
  describe('lang', () => {
    it('sets recognition.lang from the lang argument', () => {
      const { result } = renderHook(() => useSpeechRecognition('fr-FR'));
      act(() => {
        result.current.start();
      });
      expect(mockInstance.lang).toBe('fr-FR');
    });

    it('leaves recognition.lang unset (browser default) when no lang is provided', () => {
      const { result } = renderHook(() => useSpeechRecognition());
      act(() => {
        result.current.start();
      });
      expect(mockInstance.lang).toBe('');
    });

    it('uses the latest lang value at start() time without requiring a new start callback', () => {
      const { result, rerender } = renderHook(({ lang }) => useSpeechRecognition(lang), {
        initialProps: { lang: 'de-DE' },
      });
      rerender({ lang: 'es-ES' });
      act(() => {
        result.current.start();
      });
      expect(mockInstance.lang).toBe('es-ES');
    });
  });
});
