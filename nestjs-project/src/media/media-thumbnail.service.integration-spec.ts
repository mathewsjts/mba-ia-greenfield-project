import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaProbeService } from './media-probe.service';
import {
  MediaThumbnailService,
  thumbnailOffset,
} from './media-thumbnail.service';

const fixture = (name: string) =>
  join(__dirname, '../../test/fixtures/media', name);

describe('MediaThumbnailService (integration — real ffmpeg)', () => {
  const service = new MediaThumbnailService();
  const probe = new MediaProbeService();
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'thumbnail-'));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  async function widthOf(jpeg: Buffer): Promise<number | null> {
    const path = join(workDir, `${Date.now()}.jpg`);
    writeFileSync(path, jpeg);
    return (await probe.probe(path)).width;
  }

  it.each([
    ['h264-aac.mp4', 2],
    ['short-0_5s.mp4', 0.5],
  ])('should extract a 1280px-wide JPEG from %s', async (name, duration) => {
    const jpeg = await service.extractFrame(
      fixture(name),
      thumbnailOffset(duration),
    );

    expect(jpeg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(await widthOf(jpeg)).toBe(1280);
  });
});
