import { Job, UnrecoverableError } from 'bullmq';
import type {
  MediaProbeService,
  ProbeResult,
} from '../media/media-probe.service';
import type { MediaThumbnailService } from '../media/media-thumbnail.service';
import { MediaUnreadableError } from '../media/media.errors';
import type { ProcessVideoJobData } from '../queue/queue.constants';
import type { StorageService } from '../storage/storage.service';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import type { VideosService } from '../videos/videos.service';
import { VideoProcessor } from './video.processor';

const SUPPORTED_PROBE: ProbeResult = {
  duration: 20,
  width: 1920,
  height: 1080,
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  audioCodec: 'aac',
};

const job = (overrides: Partial<Job<ProcessVideoJobData>> = {}) =>
  ({
    id: 'video-1',
    data: { videoId: 'video-1' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  }) as Job<ProcessVideoJobData>;

describe('VideoProcessor', () => {
  let videos: jest.Mocked<
    Pick<VideosService, 'findById' | 'markReady' | 'markProcessingFailed'>
  >;
  let storage: jest.Mocked<
    Pick<StorageService, 'headObject' | 'presignGetObject' | 'putObject'>
  >;
  let probe: jest.Mocked<Pick<MediaProbeService, 'probe'>>;
  let thumbnail: jest.Mocked<Pick<MediaThumbnailService, 'extractFrame'>>;
  let processor: VideoProcessor;

  beforeEach(() => {
    videos = {
      findById: jest.fn().mockResolvedValue({
        id: 'video-1',
        processing_status: VideoProcessingStatus.Processing,
      } as Video),
      markReady: jest.fn().mockResolvedValue(true),
      markProcessingFailed: jest.fn().mockResolvedValue(true),
    } as unknown as typeof videos;
    storage = {
      headObject: jest.fn().mockResolvedValue({ contentLength: 1024 }),
      presignGetObject: jest.fn().mockResolvedValue('http://minio:9000/signed'),
      putObject: jest.fn().mockResolvedValue(undefined),
    } as unknown as typeof storage;
    probe = {
      probe: jest.fn().mockResolvedValue(SUPPORTED_PROBE),
    } as unknown as typeof probe;
    thumbnail = {
      extractFrame: jest.fn().mockResolvedValue(Buffer.from([0xff, 0xd8])),
    } as unknown as typeof thumbnail;
    processor = new VideoProcessor(
      videos as unknown as VideosService,
      storage as unknown as StorageService,
      probe as unknown as MediaProbeService,
      thumbnail as unknown as MediaThumbnailService,
      {
        partSizeBytes: 5242880,
        partUrlExpiresSeconds: 900,
        mediaUrlExpiresSeconds: 3600,
      },
    );
  });

  describe('process', () => {
    it.each([
      VideoProcessingStatus.Ready,
      VideoProcessingStatus.Failed,
      VideoProcessingStatus.AwaitingUpload,
    ])(
      'should do nothing for a video that is %s (redelivery guard)',
      async (status) => {
        videos.findById.mockResolvedValue({
          id: 'video-1',
          processing_status: status,
        } as Video);

        await processor.process(job());

        expect(probe.probe).not.toHaveBeenCalled();
        expect(videos.markReady).not.toHaveBeenCalled();
      },
    );

    it('should probe through an internal presigned URL and store metadata + thumbnail', async () => {
      await processor.process(job());

      expect(storage.presignGetObject).toHaveBeenCalledWith(
        'videos/video-1/original',
        { audience: 'internal', expiresInSeconds: 3600 },
      );
      expect(thumbnail.extractFrame).toHaveBeenCalledWith(
        'http://minio:9000/signed',
        2,
      );
      expect(storage.putObject).toHaveBeenCalledWith(
        'videos/video-1/thumbnail.jpg',
        Buffer.from([0xff, 0xd8]),
        'image/jpeg',
      );
      expect(videos.markReady).toHaveBeenCalledWith('video-1', {
        duration: 20,
        width: 1920,
        height: 1080,
        container: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
      });
    });

    it('should throw UnrecoverableError for a format outside the allowlist', async () => {
      probe.probe.mockResolvedValue({ ...SUPPORTED_PROBE, videoCodec: 'hevc' });

      await expect(processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(storage.putObject).not.toHaveBeenCalled();
    });

    it('should throw UnrecoverableError for unreadable media', async () => {
      probe.probe.mockRejectedValue(
        new MediaUnreadableError('no video stream'),
      );

      await expect(processor.process(job())).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    });

    it('should let transient storage errors propagate for a retry', async () => {
      const transient = new Error('ECONNRESET');
      storage.headObject.mockRejectedValue(transient);

      await expect(processor.process(job())).rejects.toBe(transient);
    });
  });

  describe('onFailed', () => {
    it('should record unsupported_format for an UnrecoverableError on the first attempt', async () => {
      await processor.onFailed(job(), new UnrecoverableError('hevc'));

      expect(videos.markProcessingFailed).toHaveBeenCalledWith(
        'video-1',
        'unsupported_format',
      );
    });

    it('should record processing_error once all attempts are exhausted', async () => {
      await processor.onFailed(job({ attemptsMade: 3 }), new Error('boom'));

      expect(videos.markProcessingFailed).toHaveBeenCalledWith(
        'video-1',
        'processing_error',
      );
    });

    it('should leave the video untouched on an intermediate failure', async () => {
      await processor.onFailed(job({ attemptsMade: 2 }), new Error('boom'));

      expect(videos.markProcessingFailed).not.toHaveBeenCalled();
    });

    it('should not throw when recording the failure itself fails', async () => {
      videos.markProcessingFailed.mockRejectedValue(new Error('db down'));

      await expect(
        processor.onFailed(job({ attemptsMade: 3 }), new Error('boom')),
      ).resolves.toBeUndefined();
    });
  });
});
