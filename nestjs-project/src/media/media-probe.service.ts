import { Injectable } from '@nestjs/common';
import { MediaProcessFailedError, MediaUnreadableError } from './media.errors';
import { runProcess } from './run-process';

const PROBE_TIMEOUT_MS = 30_000;

export interface ProbeResult {
  duration: number | null;
  width: number | null;
  height: number | null;
  // Raw ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm".
  formatName: string;
  videoCodec: string;
  audioCodec: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
}

interface FfprobeOutput {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}

@Injectable()
export class MediaProbeService {
  async probe(inputUrl: string): Promise<ProbeResult> {
    let stdout: Buffer;
    try {
      ({ stdout } = await runProcess(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inputUrl,
        ],
        PROBE_TIMEOUT_MS,
      ));
    } catch (err) {
      // ffprobe exits non-zero when it cannot parse the input at all.
      if (err instanceof MediaProcessFailedError) {
        throw new MediaUnreadableError(err.stderr.trim() || 'ffprobe failed');
      }
      throw err;
    }
    return parseProbeOutput(stdout.toString());
  }
}

export function parseProbeOutput(json: string): ProbeResult {
  let output: FfprobeOutput;
  try {
    output = JSON.parse(json) as FfprobeOutput;
  } catch {
    throw new MediaUnreadableError('ffprobe returned invalid JSON');
  }

  const streams = output.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  if (!video?.codec_name || !output.format?.format_name) {
    throw new MediaUnreadableError('no video stream');
  }
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(output.format.duration);

  return {
    duration: Number.isFinite(duration) ? duration : null,
    width: video.width ?? null,
    height: video.height ?? null,
    formatName: output.format.format_name,
    videoCodec: video.codec_name,
    audioCodec: audio?.codec_name ?? null,
  };
}
