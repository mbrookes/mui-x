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

  // Keep composer value in sync with live transcript.
  React.useEffect(() => {
    if (!isListening) {
      return;
    }
    const combined = voiceBaseTextRef.current
      ? `${voiceBaseTextRef.current} ${transcript}`
      : transcript;
    setComposerValue(combined);
  }, [isListening, transcript]);

  // When voice ends (not initiated by the user), sync the final value once more.
  React.useEffect(() => {
    if (!isListening && transcript) {
      const combined = voiceBaseTextRef.current
        ? `${voiceBaseTextRef.current} ${transcript}`
        : transcript;
      setComposerValue(combined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isListening]);

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
