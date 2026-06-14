import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@mui/internal-test-utils';
import { useSpeechRecognition } from './useSpeechRecognition';

// ── Minimal SpeechRecognition mock ────────────────────────────────────────────

// Captures the last-created instance so tests can drive events.
let mockInstance: MockSpeechRecognition;

class MockSpeechRecognition {
  continuous = false;

  interimResults = false;

  onresult: ((event: MockSpeechRecognitionEvent) => void) | null = null;

  onerror: (() => void) | null = null;

  onend: (() => void) | null = null;

  startSpy = vi.fn();

  stopSpy = vi.fn();

  constructor() {
    // Capture the instance so tests can drive recognition events on the active mock.
    // eslint-disable-next-line consistent-this -- intentional: expose `this` to the test scope
    mockInstance = this;
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
    expect(mockInstance.startSpy).toHaveBeenCalledOnce();
  });

  it('stops recognition on unmount', () => {
    const { result, unmount } = renderHook(() => useSpeechRecognition());
    act(() => {
      result.current.start();
    });
    unmount();
    expect(mockInstance.stopSpy).toHaveBeenCalled();
  });
});
