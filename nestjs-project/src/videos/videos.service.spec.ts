import type { Queue } from 'bullmq';
import type { Repository } from 'typeorm';
import type { ChannelsService } from '../channels/channels.service';
import type { StorageService } from '../storage/storage.service';
import type { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import {
  InvalidPartNumberException,
  InvalidUploadPartsException,
  UnsupportedVideoFormatException,
  UploadExpiredException,
  UploadSizeMismatchException,
  VideoNotAwaitingUploadException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoTooLargeException,
} from './exceptions/video.exceptions';
import { VideosService } from './videos.service';

const PART_SIZE = 67108864;

describe('VideosService', () => {
  let repository: jest.Mocked<
    Pick<
      Repository<Video>,
      'create' | 'save' | 'findOne' | 'update' | 'findOneByOrFail'
    >
  >;
  let queue: jest.Mocked<Pick<Queue, 'add'>>;
  let channelsService: jest.Mocked<Pick<ChannelsService, 'findByUserId'>>;
  let storageService: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'abortMultipartUpload'
      | 'assertUploadExists'
      | 'presignUploadPart'
      | 'listParts'
      | 'completeMultipartUpload'
      | 'headObject'
      | 'deleteObject'
      | 'presignGetObject'
    >
  >;
  let service: VideosService;

  beforeEach(() => {
    repository = {
      create: jest.fn((fields) => fields as Video),
      save: jest.fn((video) =>
        Promise.resolve({ ...video, created_at: new Date() } as Video),
      ),
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
      findOneByOrFail: jest.fn(({ id }: { id: string }) =>
        Promise.resolve({ id, processing_status: 'processing' } as Video),
      ),
    } as unknown as typeof repository;
    queue = {
      add: jest.fn().mockResolvedValue({}),
    } as unknown as typeof queue;
    channelsService = {
      findByUserId: jest
        .fn()
        .mockResolvedValue({ id: 'channel-1', user_id: 'user-1' }),
    } as unknown as typeof channelsService;
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      assertUploadExists: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest.fn(
        (_key: string, _uploadId: string, partNumber: number) =>
          Promise.resolve(`https://storage.test/part-${partNumber}`),
      ),
      listParts: jest.fn().mockResolvedValue([]),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
      headObject: jest.fn().mockResolvedValue({ contentLength: 7340032 }),
      deleteObject: jest.fn().mockResolvedValue(undefined),
      presignGetObject: jest.fn().mockResolvedValue('https://storage.test/get'),
    } as unknown as typeof storageService;
    service = new VideosService(
      repository as unknown as Repository<Video>,
      channelsService as unknown as ChannelsService,
      storageService as unknown as StorageService,
      {
        partSizeBytes: PART_SIZE,
        partUrlExpiresSeconds: 900,
        mediaUrlExpiresSeconds: 3600,
      },
      queue as unknown as Queue,
    );
  });

  const dto = (
    overrides: Partial<InitiateUploadDto> = {},
  ): InitiateUploadDto => ({
    fileName: 'aula.mp4',
    size: 10737418240,
    contentType: 'video/mp4',
    ...overrides,
  });

  describe('initiateUpload', () => {
    it('should reject sizes above 10 GiB before touching storage', async () => {
      await expect(
        service.initiateUpload('user-1', dto({ size: 10737418241 })),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
    });

    it.each([
      ['clip.mov', 'video/quicktime'],
      ['clip.webm', 'video/mp4'],
      ['clip.mp4', 'video/webm'],
      ['clip', 'video/mp4'],
    ])(
      'should reject %s declared as %s with UnsupportedVideoFormatException',
      async (fileName, contentType) => {
        await expect(
          service.initiateUpload('user-1', dto({ fileName, contentType })),
        ).rejects.toBeInstanceOf(UnsupportedVideoFormatException);
        expect(storageService.createMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['clip.M4V', 'video/mp4'],
      ['clip.WEBM', 'video/webm'],
    ])('should accept %s declared as %s', async (fileName, contentType) => {
      await expect(
        service.initiateUpload('user-1', dto({ fileName, contentType })),
      ).resolves.toBeDefined();
    });

    it('should default the title to the file name without its extension', async () => {
      const { video } = await service.initiateUpload(
        'user-1',
        dto({ fileName: 'minha.aula.final.mp4' }),
      );
      expect(video.title).toBe('minha.aula.final');
    });

    it('should truncate the default title to 100 characters', async () => {
      const { video } = await service.initiateUpload(
        'user-1',
        dto({ fileName: `${'a'.repeat(150)}.mp4` }),
      );
      expect(video.title).toBe('a'.repeat(100));
    });

    it('should keep an explicit title', async () => {
      const { video } = await service.initiateUpload(
        'user-1',
        dto({ title: 'Minha intro' }),
      );
      expect(video.title).toBe('Minha intro');
    });

    it('should compute partCount from the configured part size', async () => {
      const full = await service.initiateUpload('user-1', dto());
      const small = await service.initiateUpload('user-1', dto({ size: 1 }));

      expect(full.partCount).toBe(160);
      expect(small.partCount).toBe(1);
      expect(full.video.part_size).toBe(PART_SIZE);
    });

    it('should store the draft in the caller channel with the multipart upload id', async () => {
      const { video } = await service.initiateUpload('user-1', dto());

      expect(channelsService.findByUserId).toHaveBeenCalledWith('user-1');
      expect(video.channel_id).toBe('channel-1');
      expect(video.upload_id).toBe('upload-1');
      expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
        `videos/${video.id}/original`,
        'video/mp4',
      );
    });

    it('should abort the multipart upload when persisting the draft fails', async () => {
      const failure = new Error('db down');
      repository.save.mockRejectedValueOnce(failure);

      await expect(service.initiateUpload('user-1', dto())).rejects.toBe(
        failure,
      );
      const [key] = storageService.createMultipartUpload.mock.calls[0];
      expect(storageService.abortMultipartUpload).toHaveBeenCalledWith(
        key,
        'upload-1',
      );
    });
  });

  describe('upload part operations', () => {
    const awaitingVideo = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-1',
        public_id: 'pub-1',
        size_bytes: 7340032,
        part_size: 5242880,
        upload_id: 'upload-1',
        processing_status: VideoProcessingStatus.AwaitingUpload,
        ...overrides,
      }) as Video;

    it('should report a video of another channel exactly like a missing one', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.requestPartUrls('pub-1', 'user-2', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
      expect(repository.findOne).toHaveBeenCalledWith({
        where: { public_id: 'pub-1', channel: { user_id: 'user-2' } },
      });
    });

    it.each([
      VideoProcessingStatus.Processing,
      VideoProcessingStatus.Ready,
      VideoProcessingStatus.Failed,
    ])('should reject part operations while %s', async (status) => {
      repository.findOne.mockResolvedValue(
        awaitingVideo({ processing_status: status }),
      );

      await expect(
        service.requestPartUrls('pub-1', 'user-1', [1]),
      ).rejects.toBeInstanceOf(VideoNotAwaitingUploadException);
      await expect(
        service.listUploadedParts('pub-1', 'user-1'),
      ).rejects.toBeInstanceOf(VideoNotAwaitingUploadException);
      await expect(
        service.abortUpload('pub-1', 'user-1'),
      ).rejects.toBeInstanceOf(VideoNotAwaitingUploadException);
    });

    it('should reject part numbers above the part count', async () => {
      repository.findOne.mockResolvedValue(awaitingVideo());

      await expect(
        service.requestPartUrls('pub-1', 'user-1', [3]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
      expect(storageService.presignUploadPart).not.toHaveBeenCalled();
    });

    it('should presign the requested parts in ascending order with a shared expiry', async () => {
      repository.findOne.mockResolvedValue(awaitingVideo());
      const before = Date.now();

      const result = await service.requestPartUrls('pub-1', 'user-1', [2, 1]);

      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://storage.test/part-1' },
        { partNumber: 2, url: 'https://storage.test/part-2' },
      ]);
      const expiresAt = new Date(result.expiresAt).getTime();
      expect(expiresAt).toBeGreaterThanOrEqual(before + 900_000);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        'videos/video-1/original',
        'upload-1',
        1,
        900,
      );
    });

    it('should mark the video upload_expired and throw when the multipart is gone', async () => {
      repository.findOne.mockResolvedValue(awaitingVideo());
      storageService.assertUploadExists.mockRejectedValue(
        new StorageUploadNotFoundError('upload-1'),
      );

      await expect(
        service.requestPartUrls('pub-1', 'user-1', [1]),
      ).rejects.toBeInstanceOf(UploadExpiredException);
      expect(repository.update).toHaveBeenCalledWith(
        {
          id: 'video-1',
          processing_status: VideoProcessingStatus.AwaitingUpload,
        },
        {
          processing_status: VideoProcessingStatus.Failed,
          failure_reason: 'upload_expired',
          upload_id: null,
        },
      );
    });

    it('should treat a missing multipart as already aborted', async () => {
      repository.findOne.mockResolvedValue(awaitingVideo());
      storageService.abortMultipartUpload.mockRejectedValue(
        new StorageUploadNotFoundError('upload-1'),
      );

      await expect(
        service.abortUpload('pub-1', 'user-1'),
      ).resolves.toBeUndefined();
      expect(repository.update).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'video-1' }),
        expect.objectContaining({ failure_reason: 'upload_aborted' }),
      );
    });
  });

  describe('completeUpload', () => {
    const awaitingVideo = (): Video =>
      ({
        id: 'video-1',
        public_id: 'pub-1',
        size_bytes: 7340032,
        part_size: 5242880,
        upload_id: 'upload-1',
        processing_status: VideoProcessingStatus.AwaitingUpload,
      }) as Video;
    const allParts = [
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ];

    beforeEach(() => {
      repository.findOne.mockResolvedValue(awaitingVideo());
    });

    it.each([
      [[{ partNumber: 1, etag: '"a"' }]],
      [[...allParts, { partNumber: 3, etag: '"c"' }]],
      [
        [
          { partNumber: 1, etag: '"a"' },
          { partNumber: 1, etag: '"a"' },
        ],
      ],
    ])(
      'should reject a part list that does not cover 1..partCount',
      async (parts) => {
        await expect(
          service.completeUpload('pub-1', 'user-1', parts),
        ).rejects.toBeInstanceOf(InvalidUploadPartsException);
        expect(storageService.completeMultipartUpload).not.toHaveBeenCalled();
      },
    );

    it('should map parts rejected by storage to InvalidUploadPartsException', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new StorageInvalidPartsError('InvalidPart'),
      );

      await expect(
        service.completeUpload('pub-1', 'user-1', allParts),
      ).rejects.toBeInstanceOf(InvalidUploadPartsException);
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should move to processing before enqueuing the job keyed by video id', async () => {
      const order: string[] = [];
      repository.update.mockImplementation(() => {
        order.push('update');
        return Promise.resolve({ affected: 1 } as never);
      });
      queue.add.mockImplementation(() => {
        order.push('enqueue');
        return Promise.resolve({} as never);
      });

      await service.completeUpload('pub-1', 'user-1', allParts);

      expect(order).toEqual(['update', 'enqueue']);
      expect(repository.update).toHaveBeenCalledWith(
        {
          id: 'video-1',
          processing_status: VideoProcessingStatus.AwaitingUpload,
        },
        {
          processing_status: VideoProcessingStatus.Processing,
          upload_id: null,
        },
      );
      expect(queue.add).toHaveBeenCalledWith(
        'process-video',
        { videoId: 'video-1' },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          jobId: 'video-1',
        },
      );
    });

    it('should delete the object and fail with size_mismatch when sizes differ', async () => {
      storageService.headObject.mockResolvedValue({ contentLength: 6291456 });

      await expect(
        service.completeUpload('pub-1', 'user-1', allParts),
      ).rejects.toBeInstanceOf(UploadSizeMismatchException);
      expect(storageService.deleteObject).toHaveBeenCalledWith(
        'videos/video-1/original',
      );
      expect(repository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ failure_reason: 'size_mismatch' }),
      );
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('should proceed when the multipart is gone but the object was already assembled', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new StorageUploadNotFoundError('upload-1'),
      );

      await service.completeUpload('pub-1', 'user-1', allParts);

      expect(queue.add).toHaveBeenCalledTimes(1);
    });

    it('should fail with upload_expired when neither multipart nor object exist', async () => {
      storageService.completeMultipartUpload.mockRejectedValue(
        new StorageUploadNotFoundError('upload-1'),
      );
      storageService.headObject.mockRejectedValue(
        new StorageObjectNotFoundError('videos/video-1/original'),
      );

      await expect(
        service.completeUpload('pub-1', 'user-1', allParts),
      ).rejects.toBeInstanceOf(UploadExpiredException);
      expect(repository.update).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ failure_reason: 'upload_expired' }),
      );
    });

    it('should roll back to awaiting_upload when enqueuing fails', async () => {
      const failure = new Error('redis down');
      queue.add.mockRejectedValue(failure);

      await expect(
        service.completeUpload('pub-1', 'user-1', allParts),
      ).rejects.toBe(failure);
      expect(repository.update).toHaveBeenLastCalledWith(
        { id: 'video-1', processing_status: VideoProcessingStatus.Processing },
        {
          processing_status: VideoProcessingStatus.AwaitingUpload,
          upload_id: 'upload-1',
        },
      );
    });
  });

  describe('getMediaUrl', () => {
    const readyVideo = (overrides: Partial<Video> = {}): Video =>
      ({
        id: 'video-1',
        public_id: 'pub-1',
        original_file_name: 'aula final.mp4',
        processing_status: VideoProcessingStatus.Ready,
        ...overrides,
      }) as Video;

    it('should 404 for a video of another channel', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(
        service.getMediaUrl('pub-1', 'user-2', 'stream'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it.each([
      VideoProcessingStatus.AwaitingUpload,
      VideoProcessingStatus.Processing,
      VideoProcessingStatus.Failed,
    ])('should refuse media for a video that is %s', async (status) => {
      repository.findOne.mockResolvedValue(
        readyVideo({ processing_status: status }),
      );

      await expect(
        service.getMediaUrl('pub-1', 'user-1', 'stream'),
      ).rejects.toBeInstanceOf(VideoNotReadyException);
      expect(storageService.presignGetObject).not.toHaveBeenCalled();
    });

    it.each([
      ['stream', 'videos/video-1/original', undefined],
      [
        'download',
        'videos/video-1/original',
        `attachment; filename="aula final.mp4"; filename*=UTF-8''aula%20final.mp4`,
      ],
      ['thumbnail', 'videos/video-1/thumbnail.jpg', undefined],
    ] as const)(
      'should sign %s for the public endpoint',
      async (kind, key, contentDisposition) => {
        repository.findOne.mockResolvedValue(readyVideo());
        const before = Date.now();

        const result = await service.getMediaUrl('pub-1', 'user-1', kind);

        expect(storageService.presignGetObject).toHaveBeenCalledWith(key, {
          audience: 'public',
          expiresInSeconds: 3600,
          contentDisposition,
        });
        expect(result.url).toBe('https://storage.test/get');
        expect(new Date(result.expiresAt).getTime()).toBeGreaterThanOrEqual(
          before + 3_600_000,
        );
      },
    );

    it('should keep non-ASCII file names in the UTF-8 disposition form', async () => {
      repository.findOne.mockResolvedValue(
        readyVideo({ original_file_name: 'aula "çã".mp4' }),
      );

      await service.getMediaUrl('pub-1', 'user-1', 'download');

      const [, options] = storageService.presignGetObject.mock.calls[0];
      expect(options.contentDisposition).toBe(
        `attachment; filename="aula ____.mp4"; filename*=UTF-8''${encodeURIComponent('aula "çã".mp4')}`,
      );
    });
  });
});
