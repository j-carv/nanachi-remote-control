import { WHISPER_MAX_SECONDS, WHISPER_SAMPLE_RATE, WHISPER_WAV_HEADER_BYTES } from '@nanachi/shared';
import workletUrl from './whisper-worklet.js?url&no-inline';

export function supportsWhisperRecording(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    typeof AudioContext === 'function' && typeof AudioWorkletNode === 'function' &&
    typeof OfflineAudioContext === 'function';
}

export function whisperWav(samples: Float32Array): Blob {
  const length = Math.min(samples.length, WHISPER_SAMPLE_RATE * WHISPER_MAX_SECONDS) * 2;
  const bytes = new ArrayBuffer(WHISPER_WAV_HEADER_BYTES + length);
  const header = new DataView(bytes);
  header.setUint32(0, 0x52494646); // RIFF
  header.setUint32(4, bytes.byteLength - 8, true);
  header.setUint32(8, 0x57415645); // WAVE
  header.setUint32(12, 0x666d7420); // fmt
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, WHISPER_SAMPLE_RATE, true);
  header.setUint32(28, WHISPER_SAMPLE_RATE * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  header.setUint32(36, 0x64617461); // data
  header.setUint32(40, length, true);
  for (let index = 0; index < length / 2; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    header.setInt16(WHISPER_WAV_HEADER_BYTES + index * 2, sample * (sample < 0 ? 32768 : 32767), true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

async function resample(chunks: Float32Array[], length: number, sourceRate: number): Promise<Blob> {
  if (length === 0) return whisperWav(new Float32Array());
  const samples = new AudioBuffer({ length, numberOfChannels: 1, sampleRate: sourceRate });
  const channel = samples.getChannelData(0);
  let offset = 0;
  for (const chunk of chunks) {
    channel.set(chunk, offset);
    offset += chunk.length;
  }
  if (sourceRate === WHISPER_SAMPLE_RATE) return whisperWav(channel);
  const frames = Math.max(1, Math.floor(length * WHISPER_SAMPLE_RATE / sourceRate));
  const offline = new OfflineAudioContext(1, frames, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = samples;
  source.connect(offline.destination);
  source.start();
  return whisperWav((await offline.startRendering()).getChannelData(0));
}

export interface WhisperRecording {
  stop(): Promise<Blob>;
}

export async function startWhisperRecording(signal: AbortSignal, interrupted: () => void): Promise<WhisperRecording> {
  const context = new AudioContext();
  const resumed = context.resume();
  void resumed.catch(() => undefined);
  let stream: MediaStream | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let worklet: AudioWorkletNode | undefined;
  const chunks: Float32Array[] = [];
  let frames = 0;
  let flushed: (() => void) | undefined;

  function release() {
    signal.removeEventListener('abort', release);
    for (const track of stream?.getTracks() ?? []) {
      track.removeEventListener('ended', interrupted);
      track.stop();
    }
    source?.disconnect();
    worklet?.disconnect();
    worklet?.port.close();
    if (context.state !== 'closed') void context.close().catch(() => undefined);
    flushed?.();
  }

  signal.addEventListener('abort', release, { once: true });
  try {
    signal.throwIfAborted();
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    signal.throwIfAborted();
    await Promise.all([resumed, context.audioWorklet.addModule(workletUrl)]);
    signal.throwIfAborted();
    source = context.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(context, 'whisper-capture', {
      channelCount: 1,
      channelCountMode: 'explicit',
      processorOptions: { maxSamples: context.sampleRate * WHISPER_MAX_SECONDS },
    });
    worklet = node;
    node.port.onmessage = ({ data }: MessageEvent<{ samples?: Float32Array; done?: boolean }>) => {
      if (data.samples !== undefined) {
        chunks.push(data.samples);
        frames += data.samples.length;
      }
      if (data.done) flushed?.();
    };
    node.onprocessorerror = interrupted;
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', interrupted);
    // The worklet outputs silence, so the capture graph stays active without playing the microphone.
    source.connect(node);
    node.connect(context.destination);
    return {
      async stop() {
        try {
          signal.throwIfAborted();
          await new Promise<void>((resolve, reject) => {
            const timeout = window.setTimeout(() => reject(new Error('Audio capture did not stop')), 2_000);
            flushed = () => {
              window.clearTimeout(timeout);
              resolve();
            };
            node.port.postMessage({ stop: true });
          });
          signal.throwIfAborted();
        } finally {
          release();
        }
        return resample(chunks, frames, context.sampleRate);
      },
    };
  } catch (error) {
    release();
    throw error;
  }
}
