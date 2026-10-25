import { join } from 'node:path';
import { MediaProcessTimeoutError, MediaUnreadableError } from './media.errors';
import { MediaProbeService } from './media-probe.service';
import { classifyFormat } from './media-format';
import { runProcess } from './run-process';

const fixture = (name: string) =>
  join(__dirname, '../../test/fixtures/media', name);

describe('MediaProbeService (integration — real ffprobe)', () => {
  const service = new MediaProbeService();

  it('should extract metadata from an H.264/AAC MP4', async () => {
    const result = await service.probe(fixture('h264-aac.mp4'));

    expect(result.duration).toBeCloseTo(2, 1);
    expect(result.width).toBe(320);
    expect(result.height).toBe(240);
    expect(result.videoCodec).toBe('h264');
    expect(result.audioCodec).toBe('aac');
    expect(classifyFormat(result)).toEqual({
      supported: true,
      container: 'mp4',
    });
  });

  it('should classify a VP9/Opus WebM as supported webm', async () => {
    const result = await service.probe(fixture('vp9-opus.webm'));

    expect(result.videoCodec).toBe('vp9');
    expect(result.audioCodec).toBe('opus');
    expect(classifyFormat(result)).toEqual({
      supported: true,
      container: 'webm',
    });
  });

  it('should report a null audio codec for a video without audio', async () => {
    const result = await service.probe(fixture('h264-noaudio.mp4'));

    expect(result.audioCodec).toBeNull();
  });

  it('should classify HEVC as unsupported', async () => {
    const result = await service.probe(fixture('hevc.mp4'));

    expect(result.videoCodec).toBe('hevc');
    expect(classifyFormat(result)).toEqual({ supported: false });
  });

  it('should throw MediaUnreadableError for non-video bytes', async () => {
    await expect(
      service.probe(fixture('not-a-video.mp4')),
    ).rejects.toBeInstanceOf(MediaUnreadableError);
  });

  it('should kill a process that exceeds its timeout', async () => {
    const started = Date.now();

    await expect(runProcess('sleep', ['10'], 200)).rejects.toBeInstanceOf(
      MediaProcessTimeoutError,
    );
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
