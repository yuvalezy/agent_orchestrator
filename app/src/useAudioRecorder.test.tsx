import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Composer } from './Composer';

/**
 * jsdom ships neither MediaRecorder nor getUserMedia, so we stand up minimal fakes: a stream whose
 * tracks can be stopped, and a recorder that emits one audio chunk then fires `stop` synchronously
 * when asked. That's enough to drive the composer's start → stop → append path end to end.
 */
class FakeMediaRecorder {
  static isTypeSupported = (): boolean => true;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm';
  private listeners: Record<string, Array<(event: unknown) => void>> = {};

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    if (options?.mimeType) this.mimeType = options.mimeType;
  }
  addEventListener(type: string, cb: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.emit('dataavailable', { data: new Blob(['audio-bytes'], { type: 'audio/webm' }) });
    this.emit('stop', {});
  }
  private emit(type: string, event: unknown): void {
    (this.listeners[type] ?? []).forEach((cb) => cb(event));
  }
}

const stopTrack = vi.fn();
const getUserMedia = vi.fn(() => Promise.resolve({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream));

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, ...response } as Response)));
}

beforeEach(() => {
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  getUserMedia.mockClear();
  stopTrack.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, 'mediaDevices');
});

const box = (): HTMLTextAreaElement => screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;

describe('Composer voice input', () => {
  it('records, transcribes, and appends the transcript to a half-typed message', async () => {
    mockFetch({ json: () => Promise.resolve({ data: { text: 'ship the release' } }) });
    render(<Composer onSend={vi.fn()} sending={false} />);

    fireEvent.change(box(), { target: { value: 'draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));

    // getUserMedia is async — wait for the recorder to flip into the recording state.
    const stopButton = await screen.findByRole('button', { name: 'Stop recording' });
    fireEvent.click(stopButton);

    await waitFor(() => expect(box().value).toBe('draft ship the release'));
    // POSTed raw audio bytes to the pinned endpoint with the blob's content-type and credentials.
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith(
      '/app/api/transcribe',
      expect.objectContaining({ method: 'POST', credentials: 'include' }),
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.body).toBeInstanceOf(Blob);
    expect(stopTrack).toHaveBeenCalled(); // mic track released after the clip.
  });

  it('shows the unavailable note when transcription is not configured (503)', async () => {
    mockFetch({ ok: false, status: 503, json: () => Promise.resolve({ error: 'not configured' }) });
    render(<Composer onSend={vi.fn()} sending={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Stop recording' }));

    expect(await screen.findByText("Voice isn't available right now.")).toBeInTheDocument();
    expect(box().value).toBe('');
  });

  it('surfaces an inline note when microphone access is blocked', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('denied'));
    render(<Composer onSend={vi.fn()} sending={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record voice message' }));

    expect(await screen.findByText('Microphone access was blocked.')).toBeInTheDocument();
  });

  it('hides the mic button when the browser cannot record', () => {
    Reflect.deleteProperty(navigator, 'mediaDevices');
    render(<Composer onSend={vi.fn()} sending={false} />);
    expect(screen.queryByRole('button', { name: 'Record voice message' })).not.toBeInTheDocument();
  });
});
