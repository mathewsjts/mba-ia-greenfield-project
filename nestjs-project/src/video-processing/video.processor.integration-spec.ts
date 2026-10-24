import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { Job, Queue, UnrecoverableError } from 'bullmq';
import { DataSource } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import videosConfig from '../config/videos.config';
import { MediaProbeService } from '../media/media-probe.service';
import { MediaThumbnailService } from '../media/media-thumbnail.service';
import type { ProcessVideoJobData } from '../queue/queue.constants';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { testStorageConfig } from '../test/storage-test-config';
import { User } from '../users/entities/user.entity';
import { generatePublicId } from '../videos/public-id';
import { Video, VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';
import { VideoProcessor } from './video.processor';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const fixture = (name: string) =>
  readFileSync(join(__dirname, '../../test/fixtures/media', name));

describe('VideoProcessor (integration — DB + MinIO + ffmpeg)', () => {
  let dataSource: DataSource;
  let storageModule: TestingModule;
  let storage: StorageService;
  let processor: VideoProcessor;
  let channel: Channel;
  const storedKeys: string[] = [];

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
    const videosService = new VideosService(
      dataSource.getRepository(Video),
      new ChannelsService(dataSource),
      storage,
      videosConfig(),
      {} as Queue<ProcessVideoJobData>,
    );
    processor = new VideoProcessor(
      videosService,
      storage,
      new MediaProbeService(),
      new MediaThumbnailService(),
      videosConfig(),
    );
  }, 30000);

  afterAll(async () => {
    await Promise.all(storedKeys.map((key) => storage.deleteObject(key)));
    await storageModule.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource
      .getRepository(User)
      .save({ email: 'processor@example.com', password: 'hashed' });
    channel = await dataSource.getRepository(Channel).save({
      name: 'processor',
      nickname: 'processor',
      user_id: user.id,
    });
  });

  async function processingVideoWith(fixtureName: string): Promise<Video> {
    const bytes = fixture(fixtureName);
    const video = await dataSource.getRepository(Video).save({
      public_id: generatePublicId(),
      channel_id: channel.id,
      title: fixtureName,
      original_file_name: fixtureName,
      content_type: 'video/mp4',
      size_bytes: bytes.length,
      part_size: 5242880,
      processing_status: VideoProcessingStatus.Processing,
    });
    await storage.putObject(originalKey(video.id), bytes, 'video/mp4');
    storedKeys.push(originalKey(video.id), thumbnailKey(video.id));
    return video;
  }

  const jobFor = (video: Video, attemptsMade = 1) =>
    ({
      id: video.id,
      data: { videoId: video.id },
      attemptsMade,
      opts: { attempts: 3 },
    }) as Job<ProcessVideoJobData>;

  const reload = (video: Video) =>
    dataSource.getRepository(Video).findOneByOrFail({ id: video.id });

  it('should mark an H.264/AAC MP4 ready with metadata and a stored thumbnail', async () => {
    const video = await processingVideoWith('h264-aac.mp4');

    await processor.process(jobFor(video));

    const row = await reload(video);
    expect(row.processing_status).toBe(VideoProcessingStatus.Ready);
    expect(row.container).toBe('mp4');
    expect(row.video_codec).toBe('h264');
    expect(row.audio_codec).toBe('aac');
    expect(row.duration).toBeCloseTo(2, 1);
    expect(row.width).toBe(320);
    expect(row.height).toBe(240);
    const thumb = await storage.headObject(thumbnailKey(video.id));
    expect(thumb.contentType).toBe('image/jpeg');
    expect(thumb.contentLength).toBeGreaterThan(0);
  }, 30000);

  it.each(['hevc.mp4', 'not-a-video.mp4'])(
    'should fail %s as unsupported_format on the first attempt',
    async (name) => {
      const video = await processingVideoWith(name);
      const job = jobFor(video, 1);

      const error = await processor.process(job).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(UnrecoverableError);
      await processor.onFailed(job, error as Error);

      const row = await reload(video);
      expect(row.processing_status).toBe(VideoProcessingStatus.Failed);
      expect(row.failure_reason).toBe('unsupported_format');
    },
    30000,
  );

  it('should leave a ready video and its thumbnail untouched on redelivery', async () => {
    const video = await processingVideoWith('h264-aac.mp4');
    await processor.process(jobFor(video));
    const before = await reload(video);
    const thumbBefore = await storage.headObject(thumbnailKey(video.id));

    await processor.process(jobFor(video));

    expect(await reload(video)).toEqual(before);
    expect(await storage.headObject(thumbnailKey(video.id))).toEqual(
      thumbBefore,
    );
  }, 30000);

  describe('range reads (TD-09)', () => {
    const SLICE = 64 * 1024;
    const zeros = Buffer.alloc(SLICE);
    const head = fixture('h264-aac.mp4');

    // Serves a real video followed by `paddingBytes` of zeros, generated on the
    // fly, and returns the URL plus a counter of bytes actually sent.
    async function serveVirtualFile(paddingBytes: number) {
      const total = head.length + paddingBytes;
      const sockets = new Set<Socket>();
      const counter = { bytes: 0 };
      const server = createServer((req, res) => {
        if (!sockets.has(req.socket)) {
          sockets.add(req.socket);
          req.socket.once('close', () => {
            counter.bytes += req.socket.bytesWritten;
          });
        }
        const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '');
        const start = match ? Number(match[1]) : 0;
        const end = match?.[2] ? Number(match[2]) : total - 1;
        res.writeHead(match ? 206 : 200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          'Content-Type': 'video/mp4',
          ...(match && { 'Content-Range': `bytes ${start}-${end}/${total}` }),
        });
        // Backpressured slices, like storage under TCP flow control: a reader
        // that stops early stops the transfer.
        const slices = function* () {
          for (let offset = start; offset <= end; offset += SLICE) {
            const sliceEnd = Math.min(offset + SLICE, end + 1);
            yield offset < head.length
              ? head.subarray(offset, Math.min(sliceEnd, head.length))
              : zeros.subarray(0, sliceEnd - offset);
          }
        };
        const body = Readable.from(slices());
        res.on('close', () => body.destroy());
        body.pipe(res);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/video.mp4`;
      const close = () =>
        new Promise<void>((resolve) => server.close(() => resolve()));
      return { url, counter, close, total };
    }

    async function bytesReadFor(paddingBytes: number) {
      const file = await serveVirtualFile(paddingBytes);
      try {
        const probe = await new MediaProbeService().probe(file.url);
        expect(probe.videoCodec).toBe('h264');
        await new MediaThumbnailService().extractFrame(file.url, 0.2);
        // Let the closed sockets report their byte counts.
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { read: file.counter.bytes, total: file.total };
      } finally {
        await file.close();
      }
    }

    it('should read a bounded number of bytes, independent of the original size', async () => {
      const small = await bytesReadFor(64 * 1024 * 1024);
      const large = await bytesReadFor(1024 * 1024 * 1024);

      expect(small.read).toBeGreaterThan(0);
      // 16x larger file, roughly the same bytes read (only socket buffering).
      expect(large.read).toBeLessThan(small.read * 2);
      expect(large.read).toBeLessThan(large.total / 20);
    }, 60000);
  });
});
