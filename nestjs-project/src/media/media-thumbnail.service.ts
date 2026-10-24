import { Injectable } from '@nestjs/common';
import { runProcess } from './run-process';

const THUMBNAIL_TIMEOUT_MS = 60_000;
const THUMBNAIL_WIDTH = 1280;

// Frame at 10% of the duration; the first frame for clips shorter than 1 s.
export function thumbnailOffset(duration: number | null): number {
  if (duration === null || duration < 1) return 0;
  return duration * 0.1;
}

@Injectable()
export class MediaThumbnailService {
  async extractFrame(inputUrl: string, atSeconds: number): Promise<Buffer> {
    const { stdout } = await runProcess(
      'ffmpeg',
      [
        '-v',
        'error',
        // Input seek (before -i): over HTTP only the bytes around the frame are read.
        '-ss',
        atSeconds.toFixed(3),
        '-i',
        inputUrl,
        '-frames:v',
        '1',
        '-vf',
        `scale=${THUMBNAIL_WIDTH}:-2`,
        '-f',
        'image2',
        '-c:v',
        'mjpeg',
        'pipe:1',
      ],
      THUMBNAIL_TIMEOUT_MS,
    );
    return stdout;
  }
}
