import type { ProbeResult } from './media-probe.service';

export type ContainerFamily = 'mp4' | 'webm';

export type FormatClassification =
  | { supported: true; container: ContainerFamily }
  | { supported: false };

// Browser-playable pairings (phase-03-videos/TD-18): stored as uploaded, never transcoded.
const VIDEO_CODECS: Record<ContainerFamily, readonly string[]> = {
  mp4: ['h264', 'vp9', 'av1'],
  webm: ['vp8', 'vp9', 'av1'],
};
const AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis'];

// ffprobe reports MP4 and MOV as one family, and MKV and WebM as another,
// so the container alone never decides support; the codecs do.
function containerFamily(formatName: string): ContainerFamily | null {
  const names = formatName.split(',');
  if (names.includes('mp4')) return 'mp4';
  if (names.includes('webm')) return 'webm';
  return null;
}

export function classifyFormat(probe: ProbeResult): FormatClassification {
  const container = containerFamily(probe.formatName);
  if (!container || !VIDEO_CODECS[container].includes(probe.videoCodec)) {
    return { supported: false };
  }
  if (probe.audioCodec !== null && !AUDIO_CODECS.includes(probe.audioCodec)) {
    return { supported: false };
  }
  return { supported: true, container };
}
