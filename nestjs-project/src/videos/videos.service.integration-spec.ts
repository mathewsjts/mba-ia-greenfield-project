import { Queue } from 'bullmq';
import { DataSource } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { testStorageConfig } from '../test/storage-test-config';
import { User } from '../users/entities/user.entity';
import { Video, VideoProcessingStatus } from './entities/video.entity';
import { UploadExpiredException } from './exceptions/video.exceptions';
import { generatePublicId } from './public-id';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let storageModule: TestingModule;
  let storage: StorageService;
  let service: VideosService;
  let queue: Queue<ProcessVideoJobData>;
  let channel: Channel;
  const openUploads: { key: string; uploadId: string }[] = [];

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    storageModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    })
      .overrideProvider(storageConfig.KEY)
      .useValue(testStorageConfig())
      .compile();
    storage = storageModule.get(StorageService);
    const { host, port } = queueConfig();
    // Test-scoped prefix: a running video-worker never sees these jobs.
    queue = new Queue(VIDEO_PROCESSING_QUEUE, {
      prefix: 'streamtube-test',
      connection: { host, port },
    });
    service = new VideosService(
      dataSource.getRepository(Video),
      new ChannelsService(dataSource),
      storage,
      // S3 minimum part size keeps multipart payloads small in tests.
      { ...videosConfig(), partSizeBytes: 5242880 },
      queue,
    );
  });

  afterAll(async () => {
    for (const { key, uploadId } of openUploads) {
      await storage.abortMultipartUpload(key, uploadId).catch(() => undefined);
    }
    await queue.obliterate({ force: true });
    await queue.close();
    await storageModule.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'uploader@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'uploader',
      nickname: 'uploader',
      user_id: user.id,
    });
  });

  describe('initiateUpload', () => {
    it('should persist the draft and open a multipart upload at the original key', async () => {
      const { video, partCount } = await service.initiateUpload(
        channel.user_id,
        { fileName: 'aula.mp4', size: 2048, contentType: 'video/mp4' },
      );
      openUploads.push({
        key: originalKey(video.id),
        uploadId: video.upload_id!,
      });

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(row.channel_id).toBe(channel.id);
      expect(row.upload_id).toBe(video.upload_id);
      expect(row.part_size).toBe(5242880);
      expect(row.public_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(partCount).toBe(1);

      await expect(
        storage.listParts(originalKey(video.id), row.upload_id!),
      ).resolves.toEqual([]);
    });
  });

  describe('upload part operations', () => {
    const MIB = 1024 * 1024;

    async function initiateDraft() {
      const { video } = await service.initiateUpload(channel.user_id, {
        fileName: 'aula.mp4',
        size: 5 * MIB + 2048,
        contentType: 'video/mp4',
      });
      openUploads.push({
        key: originalKey(video.id),
        uploadId: video.upload_id!,
      });
      return video;
    }

    async function put(url: string, bytes: number): Promise<string> {
      const res = await fetch(url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(bytes, 7)),
      });
      expect(res.status).toBe(200);
      return res.headers.get('etag')!;
    }

    it('should issue URLs that accept PUTs and list the stored parts', async () => {
      const video = await initiateDraft();

      const { parts } = await service.requestPartUrls(
        video.public_id,
        channel.user_id,
        [1, 2],
      );
      const etag1 = await put(parts[0].url, 5 * MIB);
      const etag2 = await put(parts[1].url, 2048);

      await expect(
        service.listUploadedParts(video.public_id, channel.user_id),
      ).resolves.toEqual([
        { partNumber: 1, etag: etag1, size: 5 * MIB },
        { partNumber: 2, etag: etag2, size: 2048 },
      ]);
    });

    it('should abort the multipart and mark the video upload_aborted', async () => {
      const video = await initiateDraft();

      await service.abortUpload(video.public_id, channel.user_id);

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(row.processing_status).toBe(VideoProcessingStatus.Failed);
      expect(row.failure_reason).toBe('upload_aborted');
      expect(row.upload_id).toBeNull();
      await expect(
        storage.assertUploadExists(originalKey(video.id), video.upload_id!),
      ).rejects.toThrow();
    });

    it('should mark the video upload_expired when the multipart vanished in storage', async () => {
      const video = await initiateDraft();
      await storage.abortMultipartUpload(
        originalKey(video.id),
        video.upload_id!,
      );

      await expect(
        service.listUploadedParts(video.public_id, channel.user_id),
      ).rejects.toBeInstanceOf(UploadExpiredException);

      const row = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: video.id });
      expect(row.failure_reason).toBe('upload_expired');
    });
  });

  describe('completeUpload', () => {
    it('should assemble the upload and enqueue a single job keyed by the video id', async () => {
      const { video } = await service.initiateUpload(channel.user_id, {
        fileName: 'aula.mp4',
        size: 4096,
        contentType: 'video/mp4',
      });
      const {
        parts: [part],
      } = await service.requestPartUrls(video.public_id, channel.user_id, [1]);
      const put = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(4096, 5)),
      });
      const etag = put.headers.get('etag')!;

      const completed = await service.completeUpload(
        video.public_id,
        channel.user_id,
        [{ partNumber: 1, etag }],
      );

      expect(completed.processing_status).toBe(
        VideoProcessingStatus.Processing,
      );
      expect(completed.upload_id).toBeNull();
      await expect(
        storage.headObject(originalKey(video.id)),
      ).resolves.toMatchObject({ contentLength: 4096 });
      const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).toBe(video.id);
      expect(jobs[0].name).toBe('process-video');
      expect(jobs[0].data).toEqual({ videoId: video.id });

      await expect(
        service.completeUpload(video.public_id, channel.user_id, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toThrow();
      expect(
        await queue.getJobs(['waiting', 'delayed', 'active']),
      ).toHaveLength(1);

      await storage.deleteObject(originalKey(video.id));
    });
  });

  describe('processing transitions', () => {
    async function videoIn(status: VideoProcessingStatus): Promise<Video> {
      return dataSource.getRepository(Video).save({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'aula',
        original_file_name: 'aula.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        part_size: 5242880,
        processing_status: status,
      });
    }

    const metadata = {
      duration: 12.5,
      width: 1280,
      height: 720,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: null,
    };

    it('should persist metadata and mark ready only from processing', async () => {
      const processing = await videoIn(VideoProcessingStatus.Processing);
      const failed = await videoIn(VideoProcessingStatus.Failed);

      await expect(service.markReady(processing.id, metadata)).resolves.toBe(
        true,
      );
      await expect(service.markReady(failed.id, metadata)).resolves.toBe(false);

      const ready = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: processing.id });
      expect(ready).toMatchObject({
        processing_status: VideoProcessingStatus.Ready,
        duration: 12.5,
        width: 1280,
        height: 720,
        container: 'mp4',
        video_codec: 'h264',
        audio_codec: null,
      });
      const untouched = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: failed.id });
      expect(untouched.processing_status).toBe(VideoProcessingStatus.Failed);
      expect(untouched.duration).toBeNull();
    });

    it('should record a processing failure only from processing', async () => {
      const processing = await videoIn(VideoProcessingStatus.Processing);
      const ready = await videoIn(VideoProcessingStatus.Ready);

      await expect(
        service.markProcessingFailed(processing.id, 'processing_error'),
      ).resolves.toBe(true);
      await expect(
        service.markProcessingFailed(ready.id, 'processing_error'),
      ).resolves.toBe(false);

      const failed = await dataSource
        .getRepository(Video)
        .findOneByOrFail({ id: processing.id });
      expect(failed.failure_reason).toBe('processing_error');
      expect(
        (
          await dataSource
            .getRepository(Video)
            .findOneByOrFail({ id: ready.id })
        ).processing_status,
      ).toBe(VideoProcessingStatus.Ready);
    });
  });

  describe('getMediaUrl', () => {
    const body = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

    async function readyVideo(): Promise<Video> {
      const video = await dataSource.getRepository(Video).save({
        public_id: generatePublicId(),
        channel_id: channel.id,
        title: 'aula',
        original_file_name: 'aula final.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length,
        part_size: 5242880,
        processing_status: VideoProcessingStatus.Ready,
      });
      await storage.putObject(originalKey(video.id), body, 'video/mp4');
      await storage.putObject(thumbnailKey(video.id), jpeg, 'image/jpeg');
      return video;
    }

    async function cleanup(video: Video) {
      await storage.deleteObject(originalKey(video.id));
      await storage.deleteObject(thumbnailKey(video.id));
    }

    it('should serve stream ranges, attachment downloads and the thumbnail', async () => {
      const video = await readyVideo();
      try {
        const stream = await service.getMediaUrl(
          video.public_id,
          channel.user_id,
          'stream',
        );
        const ranged = await fetch(stream.url, {
          headers: { Range: 'bytes=0-1023' },
        });
        expect(ranged.status).toBe(206);
        expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
          body.subarray(0, 1024),
        );

        const download = await service.getMediaUrl(
          video.public_id,
          channel.user_id,
          'download',
        );
        const downloaded = await fetch(download.url);
        expect(downloaded.headers.get('content-disposition')).toContain(
          'attachment; filename="aula final.mp4"',
        );

        const thumbnail = await service.getMediaUrl(
          video.public_id,
          channel.user_id,
          'thumbnail',
        );
        const thumb = await fetch(thumbnail.url);
        expect(thumb.status).toBe(200);
        expect(thumb.headers.get('content-type')).toBe('image/jpeg');
      } finally {
        await cleanup(video);
      }
    });
  });
});
