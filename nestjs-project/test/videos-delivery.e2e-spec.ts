import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import { originalKey, thumbnailKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  Video,
  VideoProcessingStatus,
} from '../src/videos/entities/video.entity';
import { generatePublicId } from '../src/videos/public-id';
import {
  VideosTestContext,
  createAuthenticatedUser,
  createVideosTestApp,
  resetThrottler,
} from './utils/videos-e2e';

const FIXTURE = readFileSync(join(__dirname, 'fixtures/media/h264-aac.mp4'));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46]);
const MEDIA_ROUTES = ['stream', 'download', 'thumbnail'] as const;

describe('videos-delivery', () => {
  let ctx: VideosTestContext;
  let ownerToken: string;
  let otherToken: string;
  const storedKeys: string[] = [];

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function ownerChannelId(): Promise<string> {
    const [{ id }] = await ctx.dataSource.query<{ id: string }[]>(
      `SELECT c.id FROM "channels" c JOIN "users" u ON u.id = c.user_id
       WHERE u.email = $1`,
      ['owner@example.com'],
    );
    return id;
  }

  async function seedVideo(
    processingStatus: VideoProcessingStatus,
    extra: Partial<Video> = {},
  ): Promise<Video> {
    return ctx.dataSource.getRepository(Video).save({
      public_id: generatePublicId(),
      channel_id: await ownerChannelId(),
      title: 'aula final',
      original_file_name: 'aula final.mp4',
      content_type: 'video/mp4',
      size_bytes: FIXTURE.length,
      part_size: 5242880,
      processing_status: processingStatus,
      ...extra,
    });
  }

  async function seedReadyVideo(): Promise<Video> {
    const video = await seedVideo(VideoProcessingStatus.Ready, {
      duration: 2.0,
      width: 320,
      height: 240,
      container: 'mp4',
      video_codec: 'h264',
      audio_codec: 'aac',
    });
    await ctx.storage.putObject(originalKey(video.id), FIXTURE, 'video/mp4');
    await ctx.storage.putObject(thumbnailKey(video.id), JPEG, 'image/jpeg');
    storedKeys.push(originalKey(video.id), thumbnailKey(video.id));
    return video;
  }

  beforeAll(async () => {
    ctx = await createVideosTestApp({ mediaUrlExpiresSeconds: 5 });
  });

  afterAll(async () => {
    await Promise.all(storedKeys.map((key) => ctx.storage.deleteObject(key)));
    await ctx.app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx.app);
    ownerToken = await createAuthenticatedUser(ctx, 'owner@example.com');
    otherToken = await createAuthenticatedUser(ctx, 'other@example.com');
  });

  // 1. Leitura do vídeo e URLs de streaming, download e thumbnail

  it('detalhe-do-video-ready', async () => {
    const ready = await seedReadyVideo();
    const res = await http()
      .get(`/videos/${ready.public_id}`)
      .set(bearer(ownerToken))
      .expect(200);

    expect(res.body).toMatchObject({
      publicId: ready.public_id,
      status: 'draft',
      processingStatus: 'ready',
      failureReason: null,
      duration: 2,
      width: 320,
      height: 240,
      container: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      originalFileName: 'aula final.mp4',
    });
    for (const hidden of [
      'id',
      'upload_id',
      'uploadId',
      'part_size',
      'partSize',
    ]) {
      expect(res.body).not.toHaveProperty(hidden);
    }

    const processing = await seedVideo(VideoProcessingStatus.Processing);
    const pending = await http()
      .get(`/videos/${processing.public_id}`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(pending.body).toMatchObject({
      processingStatus: 'processing',
      duration: null,
      width: null,
      height: null,
      container: null,
      videoCodec: null,
      audioCodec: null,
    });
  });

  it('stream-url-com-range', async () => {
    const video = await seedReadyVideo();

    const res = await http()
      .get(`/videos/${video.public_id}/stream`)
      .set(bearer(ownerToken))
      .expect(200);
    expect(typeof res.body.url).toBe('string');
    expect(new Date(res.body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const ranged = await fetch(res.body.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get('content-range')).toBe(
      `bytes 0-1023/${FIXTURE.length}`,
    );
    expect(Buffer.from(await ranged.arrayBuffer())).toEqual(
      FIXTURE.subarray(0, 1024),
    );
  });

  it('download-url-como-anexo', async () => {
    const video = await seedReadyVideo();

    const res = await http()
      .get(`/videos/${video.public_id}/download`)
      .set(bearer(ownerToken))
      .expect(200);

    const download = await fetch(res.body.url);
    expect(download.status).toBe(200);
    const disposition = download.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment')).toBe(true);
    expect(disposition).toContain('filename="aula final.mp4"');
    expect((await download.arrayBuffer()).byteLength).toBe(FIXTURE.length);
  });

  it('thumbnail-url-entrega-jpeg', async () => {
    const video = await seedReadyVideo();

    const res = await http()
      .get(`/videos/${video.public_id}/thumbnail`)
      .set(bearer(ownerToken))
      .expect(200);

    const thumb = await fetch(res.body.url);
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    const bytes = Buffer.from(await thumb.arrayBuffer());
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it('midia-indisponivel-antes-de-ready', async () => {
    const processing = await seedVideo(VideoProcessingStatus.Processing);
    const failed = await seedVideo(VideoProcessingStatus.Failed, {
      failure_reason: 'unsupported_format',
    });

    for (const video of [processing, failed]) {
      for (const route of MEDIA_ROUTES) {
        const res = await http()
          .get(`/videos/${video.public_id}/${route}`)
          .set(bearer(ownerToken))
          .expect(409);
        expect(res.body.error).toBe('VIDEO_NOT_READY');
      }
    }
  });

  it('acesso-somente-do-owner', async () => {
    const video = await seedReadyVideo();
    const paths = (publicId: string) => [
      `/videos/${publicId}`,
      ...MEDIA_ROUTES.map((route) => `/videos/${publicId}/${route}`),
    ];

    const otherBodies: unknown[] = [];
    for (const path of paths(video.public_id)) {
      const res = await http().get(path).set(bearer(otherToken)).expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      otherBodies.push(res.body);
    }

    for (const path of paths(video.public_id)) {
      await http().get(path).expect(401);
    }

    for (const [index, path] of paths('AAAAAAAAAAA').entries()) {
      const res = await http().get(path).set(bearer(ownerToken)).expect(404);
      expect(res.body).toEqual(otherBodies[index]);
    }
  });

  it('url-expira', async () => {
    const video = await seedReadyVideo();

    const res = await http()
      .get(`/videos/${video.public_id}/stream`)
      .set(bearer(ownerToken))
      .expect(200);
    const expiresAt = new Date(res.body.expiresAt).getTime();
    expect(expiresAt - Date.now()).toBeLessThanOrEqual(5000);
    expect(expiresAt - Date.now()).toBeGreaterThan(2000);

    await new Promise((resolve) =>
      setTimeout(resolve, expiresAt - Date.now() + 2000),
    );
    const expired = await fetch(res.body.url);
    expect(expired.status).toBe(403);
  }, 20000);
});
