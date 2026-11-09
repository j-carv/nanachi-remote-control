import { useEffect, useRef, useState } from 'react';
import {
  WHISPER_MAX_SECONDS,
  WHISPER_WAV_HEADER_BYTES,
  type AppLanguage,
  type WhisperLanguage,
} from '@nanachi/shared';
import { ApiError, type ApiClient } from '../api.js';
import { startWhisperRecording, type WhisperRecording } from './recording.js';

const LANGUAGES: Record<AppLanguage, WhisperLanguage> = { 'pt-BR': 'pt', en: 'en', es: 'es' };
type Stage = 'idle' | 'starting' | 'recording' | 'transcribing';
type Failure = 'blocked' | 'microphoneFailed' | 'network' | 'noSpeech' | 'busy' | 'unavailable' | 'timeout' | 'failed';

interface Clip {
  controller: AbortController;
  recording?: WhisperRecording;
  interval?: number;
  timeout?: number;
  stopping?: boolean;
}

function release(clip: Clip) {
  window.clearInterval(clip.interval);
  window.clearTimeout(clip.timeout);
  clip.controller.abort();
}

function transcriptionFailure(error: unknown): Failure {
  if (!(error instanceof ApiError)) return 'failed';
  if (error.kind === 'network') return 'network';
  switch (error.code) {
    case 'transcription_no_speech': return 'noSpeech';
    case 'transcription_busy': return 'busy';
    case 'transcription_not_ready':
    case 'transcription_cancelled':
    case 'transcription_unsupported': return 'unavailable';
    case 'transcription_timeout': return 'timeout';
    default: return 'failed';
  }
}

export function appendWhisperTranscript(draft: string, text: string): string {
  const separator = draft.length === 0 || /\s$/.test(draft) ? '' : ' ';
  return draft + separator + text;
}

export function useWhisperDictation(
  api: ApiClient,
  sessionId: string,
  language: AppLanguage,
  onTranscript: (text: string) => void,
) {
  const active = useRef<Clip | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);

  function finish(clip: Clip, error: Failure | null = null) {
    if (active.current !== clip) return;
    active.current = null;
    release(clip);
    setStage('idle');
    setFailure(error);
  }

  function cancel() {
    if (active.current !== null) finish(active.current);
  }

  useEffect(() => {
    setStage('idle');
    setFailure(null);
    function onVisibility() {
      const clip = active.current;
      if (document.visibilityState === 'hidden' && clip !== null && !clip.stopping) {
        finish(clip, 'microphoneFailed');
      }
    }
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      const clip = active.current;
      active.current = null;
      if (clip !== null) release(clip);
    };
  }, [api, sessionId]);

  async function stop(clip = active.current) {
    if (clip === null || clip.recording === undefined || clip.stopping) return;
    clip.stopping = true;
    window.clearInterval(clip.interval);
    window.clearTimeout(clip.timeout);
    setStage('transcribing');
    try {
      const audio = await clip.recording.stop();
      if (active.current !== clip) return;
      if (audio.size <= WHISPER_WAV_HEADER_BYTES) {
        finish(clip, 'noSpeech');
        return;
      }
      const { text } = await api.transcribeAudio(audio, LANGUAGES[language], clip.controller.signal);
      if (active.current !== clip) return;
      onTranscript(text);
      finish(clip);
    } catch (error) {
      finish(clip, transcriptionFailure(error));
    }
  }

  async function start() {
    if (active.current !== null) return;
    const clip: Clip = { controller: new AbortController() };
    active.current = clip;
    setStage('starting');
    setElapsed(0);
    setFailure(null);
    try {
      clip.recording = await startWhisperRecording(clip.controller.signal, () => finish(clip, 'microphoneFailed'));
      if (active.current !== clip) return;
      setStage('recording');
      const start = performance.now();
      clip.interval = window.setInterval(() => {
        setElapsed(Math.min(WHISPER_MAX_SECONDS, Math.floor((performance.now() - start) / 1_000)));
      }, 250);
      clip.timeout = window.setTimeout(() => void stop(clip), WHISPER_MAX_SECONDS * 1_000);
    } catch (error) {
      const blocked = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
      finish(clip, blocked ? 'blocked' : 'microphoneFailed');
    }
  }

  return { stage, elapsed, failure, start, stop, cancel };
}
