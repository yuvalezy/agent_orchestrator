import { useCallback, useRef, useState } from 'react';
import type { ApiError } from './lib/api';

export type RecorderState = 'idle' | 'recording' | 'transcribing';

export interface AudioRecorder {
  state: RecorderState;
  /** Ask for the mic and begin capturing. Permission/unsupported failures surface via `error`. */
  start: () => void;
  /** Stop, POST the clip, and resolve the transcript (or null on empty clip / failure). */
  stopAndTranscribe: () => Promise<string | null>;
  error: string | null;
}

/** Feature-detect the recording stack — the mic button is hidden when this is false. */
export function canRecordAudio(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof MediaRecorder !== 'undefined'
  );
}

/** Prefer webm; fall back to the recorder's default when the browser can't do it (e.g. Safari). */
function recorderOptions(): MediaRecorderOptions | undefined {
  return MediaRecorder.isTypeSupported?.('audio/webm') ? { mimeType: 'audio/webm' } : undefined;
}

/**
 * POST raw audio bytes to the transcribe endpoint. The shared api() helper is JSON-only, so this
 * mirrors its contract by hand: send the blob with credentials, echo the 401 unauthorized dispatch,
 * and throw the same ApiError shape (message + status) so callers can branch on 503.
 */
async function transcribe(blob: Blob): Promise<string> {
  const response = await fetch('/app/api/transcribe', {
    method: 'POST',
    body: blob,
    headers: { 'content-type': blob.type || 'audio/webm' },
    credentials: 'include',
  });
  if (!response.ok) {
    if (response.status === 401) window.dispatchEvent(new Event('app:unauthorized'));
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    const error = new Error(body.error ?? 'Request failed') as ApiError;
    error.status = response.status;
    throw error;
  }
  const result = (await response.json()) as { data: { text: string } };
  return result.data.text;
}

/**
 * Records a short voice clip and turns it into text. The founder taps the mic (start), speaks, taps
 * stop (stopAndTranscribe) — the clip is uploaded and the transcript resolves for the composer to
 * append. Nothing auto-sends; this is transcription-to-text-box only.
 */
export function useAudioRecorder(): AudioRecorder {
  const [state, setState] = useState<RecorderState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  const start = useCallback((): void => {
    setError(null);
    if (!canRecordAudio()) {
      setError("Voice input isn't supported on this device.");
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        streamRef.current = stream;
        chunksRef.current = [];
        const recorder = new MediaRecorder(stream, recorderOptions());
        recorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        });
        recorderRef.current = recorder;
        recorder.start();
        setState('recording');
      })
      .catch(() => {
        releaseStream();
        setError('Microphone access was blocked.');
      });
  }, [releaseStream]);

  const stopAndTranscribe = useCallback((): Promise<string | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null);
    setError(null);
    setState('transcribing');
    return new Promise<Blob>((resolve) => {
      recorder.addEventListener(
        'stop',
        () => resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })),
        { once: true },
      );
      recorder.stop();
    })
      .then((blob) => {
        releaseStream();
        recorderRef.current = null;
        if (blob.size === 0) {
          setState('idle');
          return null;
        }
        return transcribe(blob).then((text) => {
          setState('idle');
          return text;
        });
      })
      .catch((err: ApiError) => {
        releaseStream();
        recorderRef.current = null;
        setState('idle');
        setError(err.status === 503 ? "Voice isn't available right now." : "Couldn't transcribe that — try again.");
        return null;
      });
  }, [releaseStream]);

  return { state, start, stopAndTranscribe, error };
}
