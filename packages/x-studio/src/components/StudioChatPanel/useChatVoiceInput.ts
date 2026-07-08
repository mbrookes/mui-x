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
}

export function useChatVoiceInput(): UseChatVoiceInputResult {
  const {
    isSupported: voiceSupported,
    isListening,
    transcript,
    start: startVoice,
    stop: stopVoice,
    resetTranscript,
  } = useSpeechRecognition();
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

  const handleComposerValueChange = React.useCallback(
    (value: string) => {
      setComposerValue(value);
      // When the user manually edits the input while voice is active, stop listening
      // and adopt their edit as the new base.
      if (isListening) {
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
  };
}
