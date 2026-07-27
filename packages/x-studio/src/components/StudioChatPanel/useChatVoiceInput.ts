'use client';

import * as React from 'react';
import { useSpeechRecognition } from './useSpeechRecognition';

// ── Voice input wiring ────────────────────────────────────────────────────────
// Bridges `useSpeechRecognition` to the composer's controlled text value: while
// listening, the live transcript is appended to whatever text was already in
// the composer when voice input started; manually editing the composer while
// listening stops voice input and adopts the edit as the new base text.

export interface UseChatVoiceInputResult {
  voiceSupported: boolean;
  isListening: boolean;
  composerValue: string;
  handleToggleVoice: () => void;
  handleComposerValueChange: (value: string) => void;
  /**
   * Runs `fn` with composer writes marked as PROGRAMMATIC, so
   * `handleComposerValueChange` doesn't mistake them for the user typing and stop
   * dictation. Wrap any code that sets or clears the composer on the user's behalf
   * (auto-submit, "send" clearing the draft).
   */
  runProgrammaticComposerChange: (fn: () => void) => void;
}

/**
 * Resolves the BCP-47 tag dictation should run in.
 *
 * `StudioLocaleText` carries translated strings only — it has no language tag (the
 * same distinction `countryUtils.ts` documents for `Intl.DisplayNames`), so there is
 * no locale signal to read off the Studio config. `<html lang>` is the standard,
 * host-agnostic one: WCAG 3.1.1 (Language of Page) requires it, so an app that is
 * translated at all almost certainly sets it. Falling back to `undefined` (rather
 * than guessing from `navigator.language`) keeps the previous behaviour — the
 * browser/OS dictation default — for apps that don't.
 */
function resolveDictationLang(explicitLang?: string): string | undefined {
  if (explicitLang) {
    return explicitLang;
  }
  if (typeof document === 'undefined') {
    return undefined;
  }
  return document.documentElement?.lang?.trim() || undefined;
}

/**
 * @param lang - Explicit BCP-47 tag for dictation. Omit to follow the document's
 *   `<html lang>` (see `resolveDictationLang`).
 */
export function useChatVoiceInput(lang?: string): UseChatVoiceInputResult {
  const {
    isSupported: voiceSupported,
    isListening,
    transcript,
    start: startVoice,
    stop: stopVoice,
    resetTranscript,
    // Read on every render rather than memoized: `useSpeechRecognition` keeps the
    // value in a ref and only reads it when a session STARTS, so a changing string
    // never churns any callback identity.
  } = useSpeechRecognition(resolveDictationLang(lang));
  // Track the text that was in the composer before voice started.
  const voiceBaseTextRef = React.useRef('');
  // Always-controlled composer value — start with '' so ChatBox never switches
  // from uncontrolled to controlled mid-session.
  const [composerValue, setComposerValue] = React.useState('');

  const handleToggleVoice = React.useCallback(() => {
    if (isListening) {
      stopVoice();
      // Leave the finalised transcript in the composer; clear the ref.
      voiceBaseTextRef.current = '';
    } else {
      // Snapshot current composer text so we can prepend it to the transcript.
      voiceBaseTextRef.current = composerValue;
      resetTranscript();
      startVoice();
    }
  }, [isListening, composerValue, startVoice, stopVoice, resetTranscript]);

  // Keep the composer value in sync with the live transcript while listening.
  // This runs on every transcript change during a session, so by the time voice
  // ends — whether the browser auto-ends it (silence timeout, `onend`) or the user
  // stops it (mic toggle, typing) — the composer already holds the latest combined
  // value. There is deliberately no second "sync once more on stop" effect: it used
  // to fire on EVERY true→false transition and rebuild the composer from the stale,
  // never-reset `transcript` + `voiceBaseTextRef`, clobbering text the user had just
  // typed (typing-while-listening) or dropping the pre-voice base text (mic off).
  // Stale transcript can't leak into a later session because `handleToggleVoice`
  // calls `resetTranscript()` before starting a new one.
  React.useEffect(() => {
    if (!isListening) {
      return;
    }
    const combined = voiceBaseTextRef.current
      ? `${voiceBaseTextRef.current} ${transcript}`
      : transcript;
    setComposerValue(combined);
  }, [isListening, transcript]);

  // Depth (not a boolean) so nested programmatic writes can't clear the flag early.
  // Non-zero means "the composer value currently being reported back to us was written
  // by Studio itself, not typed by the user".
  const programmaticDepthRef = React.useRef(0);
  const runProgrammaticComposerChange = React.useCallback((fn: () => void) => {
    programmaticDepthRef.current += 1;
    try {
      fn();
    } finally {
      programmaticDepthRef.current -= 1;
    }
  }, []);

  const handleComposerValueChange = React.useCallback(
    (value: string) => {
      setComposerValue(value);
      // When the user manually edits the input while voice is active, stop listening
      // and adopt their edit as the new base.
      //
      // Only a USER edit counts. `ChatBox` reports every composer-store write back
      // through this callback, including Studio's own: an auto-submitted widget
      // insight sets the composer text and the send pipeline then clears it, which
      // used to read as "the user typed twice" and killed the microphone mid-sentence
      // — with no visible cause, since the user never touched the composer. Voice now
      // survives an auto-submit: the next transcript delta re-applies
      // `voiceBaseTextRef + transcript`, restoring the dictation the auto-submit
      // temporarily displaced.
      if (isListening && programmaticDepthRef.current === 0) {
        stopVoice();
        voiceBaseTextRef.current = '';
      }
    },
    [isListening, stopVoice],
  );

  return {
    voiceSupported,
    isListening,
    composerValue,
    handleToggleVoice,
    handleComposerValueChange,
    runProgrammaticComposerChange,
  };
}
