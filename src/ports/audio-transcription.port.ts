export interface AudioTranscriptionInput {
  data: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface AudioTranscriptionPort {
  transcribe(input: AudioTranscriptionInput): Promise<string>;
}
