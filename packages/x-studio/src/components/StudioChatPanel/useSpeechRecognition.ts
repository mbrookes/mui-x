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
  lang: string;
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
 *
 * @param lang - BCP-47 language tag (e.g. `'fr-FR'`) to set on the recognition
 *   session, so dictation follows the app's active locale rather than always
 *   falling back to the browser/OS default. The caller is
 *   responsible for resolving this from whatever locale signal the host app
 *   uses — `StudioLocaleText` itself carries only translated strings, not a
 *   BCP-47 tag (see `countryUtils.ts`'s `Intl.DisplayNames` comment for the
 *   same distinction). Studio's own consumer, `useChatVoiceInput`, resolves it
 *   from `<html lang>`. Omit for the browser/OS default.
 */
export function useSpeechRecognition(lang?: string): UseSpeechRecognitionReturn {
  const Ctor = React.useMemo(() => getSpeechRecognitionCtor(), []);
  const isSupported = Ctor !== null;

  // The instance that currently OWNS the hook's state. Any other instance (one that has
  // been asked to stop but whose async `onend` has not arrived yet) must not write to
  // `isListening`/`transcript` — see `start()`.
  const recognitionRef = React.useRef<SpeechRecognitionInstance | null>(null);
  // Every instance created that has not yet reported `onend`/`onerror`. `stop()` is
  // asynchronous, so an instance keeps the microphone hot for a while after the handle is
  // released from `recognitionRef`; tracking them here means unmount can still stop
  // whatever is left running instead of leaking the device until page unload.
  const liveInstancesRef = React.useRef<Set<SpeechRecognitionInstance>>(new Set());
  const [isListening, setIsListening] = React.useState(false);
  const [transcript, setTranscript] = React.useState('');

  // Read the latest `lang` at `start()` time without making `start` (and therefore
  // every consumer's callback deps) churn on every render when the caller passes a
  // fresh literal.
  const langRef = React.useRef(lang);
  langRef.current = lang;

  const start = React.useCallback(() => {
    if (!Ctor || recognitionRef.current) {
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    if (langRef.current) {
      recognition.lang = langRef.current;
    }

    liveInstancesRef.current.add(recognition);

    // Every handler is scoped to ITS OWN instance and no-ops once superseded. `stop()` is
    // asynchronous: toggling the mic off then on again (or typing, which `useChatVoiceInput`
    // turns into a `stopVoice()`) starts instance B while instance A is still winding down.
    // Unconditional handlers meant A's late `onend` cleared `recognitionRef` and flipped
    // `isListening` to false while B was still recording — after which the transcript-sync
    // effect bailed, the button showed "start", and `stop()` (including the unmount cleanup)
    // no-op'd forever, leaving the microphone on until page unload.
    recognition.onresult = (event: SpeechRecognitionEventLocal) => {
      if (recognitionRef.current !== recognition) {
        return;
      }
      let full = '';
      for (let i = 0; i < event.results.length; i += 1) {
        full += event.results[i][0].transcript;
      }
      setTranscript(full);
    };

    const handleEnd = () => {
      liveInstancesRef.current.delete(recognition);
      if (recognitionRef.current !== recognition) {
        return;
      }
      recognitionRef.current = null;
      setIsListening(false);
    };

    recognition.onerror = handleEnd;
    recognition.onend = handleEnd;

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [Ctor]);

  const stop = React.useCallback(() => {
    const recognition = recognitionRef.current;
    // Release ownership BEFORE asking the instance to stop, so a synchronous `onend` (test
    // doubles) and an asynchronous one (real browsers) take the same "already superseded"
    // path. The instance itself stays in `liveInstancesRef` until its `onend` actually
    // arrives, so unmount can still stop it if the browser never delivers one.
    recognitionRef.current = null;
    setIsListening(false);
    recognition?.stop();
  }, []);

  const resetTranscript = React.useCallback(() => {
    setTranscript('');
  }, []);

  // Cleanup on unmount: stop EVERY instance that has not reported `onend` yet, not just the
  // currently-owning one. A superseded instance still holds the microphone, and after unmount
  // nothing else can ever release it.
  React.useEffect(() => {
    const liveInstances = liveInstancesRef.current;
    return () => {
      recognitionRef.current = null;
      liveInstances.forEach((instance) => {
        try {
          instance.stop();
        } catch {
          // Already stopped/never started — nothing left to release.
        }
      });
      liveInstances.clear();
    };
  }, []);

  return { isSupported, isListening, transcript, start, stop, resetTranscript };
}
