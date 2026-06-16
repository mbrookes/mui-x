'use client';

import * as React from 'react';

export interface UseSpeechRecognitionReturn {
  /** Whether the browser supports the SpeechRecognition API. */
  isSupported: boolean;
  /** Whether the microphone is currently listening. */
  isListening: boolean;
  /** The latest partial or final transcript from the current session. */
  transcript: string;
  /** Start listening. No-op if already listening or unsupported. */
  start: () => void;
  /** Stop listening and finalise the transcript. No-op if not listening. */
  stop: () => void;
  /** Reset the transcript to an empty string without stopping recognition. */
  resetTranscript: () => void;
}

// Minimal local declarations for the SpeechRecognition browser API.
// The types are not available in all TypeScript DOM lib versions, so we
// declare just enough to make the hook compile without external packages.
interface SpeechRecognitionResult {
  readonly 0: { transcript: string };
  readonly length: number;
}
interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLocal extends Event {
  readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionInstance extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLocal) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionInstance;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Hook that wraps the browser `SpeechRecognition` API.
 *
 * Returns `isSupported: false` in non-browser environments (SSR) and in
 * browsers that do not implement the API (e.g. Firefox without the flag).
 *
 * The hook exposes a `transcript` string that the caller can append to a
 * controlled input. Transcription is continuous — it accumulates until `stop()`
 * is called or the browser ends the session automatically (e.g. silence).
 */
export function useSpeechRecognition(): UseSpeechRecognitionReturn {
  const Ctor = React.useMemo(() => getSpeechRecognitionCtor(), []);
  const isSupported = Ctor !== null;

  const recognitionRef = React.useRef<SpeechRecognitionInstance | null>(null);
  const [isListening, setIsListening] = React.useState(false);
  const [transcript, setTranscript] = React.useState('');

  const start = React.useCallback(() => {
    if (!Ctor || recognitionRef.current) {
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event: SpeechRecognitionEventLocal) => {
      let full = '';
      for (let i = 0; i < event.results.length; i += 1) {
        full += event.results[i][0].transcript;
      }
      setTranscript(full);
    };

    recognition.onerror = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [Ctor]);

  const stop = React.useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  }, []);

  const resetTranscript = React.useCallback(() => {
    setTranscript('');
  }, []);

  // Cleanup on unmount.
  React.useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
    };
  }, []);

  return { isSupported, isListening, transcript, start, stop, resetTranscript };
}
