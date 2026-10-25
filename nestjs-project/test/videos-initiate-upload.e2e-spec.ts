import {
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { testStorageConfig } from '../src/test/storage-test-config';
import { Video } from '../src/videos/entities/video.entity';
import {
  VideosTestContext,
  abortOpenUploads,
  createAuthenticatedUser,
  createVideosTestApp,
  resetThrottler,
} from './utils/videos-e2e';

describe('videos-initiate-upload', () => {
  let ctx: VideosTestContext;
  let s3: S3Client;
  let token: string;
  const bucket = testStorageConfig().bucket;

  const initiate = (body: Record<string, unknown>, auth = true) => {
    const req = request(ctx.app.getHttpServer()).post('/videos');
    if (auth) req.set('Authorization', `Bearer ${token}`);
    return req.send(body);
  };

  const openUploadCount = async (): Promise<number> => {
    const result = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: 'videos/' }),
    );
    return result.Uploads?.length ?? 0;
  };

  beforeAll(async () => {
    ctx = await createVideosTestApp();
    const config = testStorageConfig();
    s3 = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: true,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  });

  afterAll(async () => {
    await abortOpenUploads(ctx);
    s3.destroy();
    await ctx.app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads(ctx);
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx.app);
    token = await createAuthenticatedUser(ctx, 'uploader@example.com');
  });

  // 1. Pré-cadastro do rascunho e início do multipart

  it('initiate-10gib-mp4-cria-rascunho', async () => {
    const res = await initiate({
      fileName: 'aula.mp4',
      size: 10737418240,
      contentType: 'video/mp4',
    }).expect(201);

    expect(res.body).toMatchObject({
      status: 'draft',
      processingStatus: 'awaiting_upload',
      title: 'aula',
      failureReason: null,
      originalFileName: 'aula.mp4',
      contentType: 'video/mp4',
      sizeBytes: 10737418240,
      upload: { partSize: 67108864, partCount: 160 },
    });
  });

  it('initiate-acima-de-10gib-rejeitado', async () => {
    const before = await openUploadCount();

    const res = await initiate({
      fileName: 'big.mp4',
      size: 10737418241,
      contentType: 'video/mp4',
    }).expect(413);

    expect(res.body.error).toBe('VIDEO_TOO_LARGE');
    expect(await ctx.dataSource.getRepository(Video).count()).toBe(0);
    expect(await openUploadCount()).toBe(before);
  });

  it('initiate-formato-fora-da-allowlist', async () => {
    const quicktime = await initiate({
      fileName: 'clip.mov',
      size: 1048576,
      contentType: 'video/quicktime',
    }).expect(415);
    expect(quicktime.body.error).toBe('UNSUPPORTED_VIDEO_FORMAT');

    const mismatch = await initiate({
      fileName: 'clip.webm',
      size: 1048576,
      contentType: 'video/mp4',
    }).expect(415);
    expect(mismatch.body.error).toBe('UNSUPPORTED_VIDEO_FORMAT');

    await initiate({
      fileName: 'clip.WEBM',
      size: 1048576,
      contentType: 'video/webm',
    }).expect(201);
  });

  it('initiate-body-invalido', async () => {
    const valid = {
      fileName: 'aula.mp4',
      size: 1024,
      contentType: 'video/mp4',
    };

    const unknown = await initiate({ ...valid, foo: 'bar' }).expect(400);
    expect(unknown.body.error).toBe('VALIDATION_ERROR');
    expect(Array.isArray(unknown.body.message)).toBe(true);

    const fractional = await initiate({ ...valid, size: 1.5 }).expect(400);
    expect(fractional.body.error).toBe('VALIDATION_ERROR');

    const withoutFileName = {
      size: valid.size,
      contentType: valid.contentType,
    };
    const missing = await initiate(withoutFileName).expect(400);
    expect(missing.body.error).toBe('VALIDATION_ERROR');

    const emptyTitle = await initiate({ ...valid, title: '   ' }).expect(400);
    expect(emptyTitle.body.error).toBe('VALIDATION_ERROR');

    const longTitle = await initiate({
      ...valid,
      title: 'a'.repeat(101),
    }).expect(400);
    expect(longTitle.body.error).toBe('VALIDATION_ERROR');
  });

  it('initiate-sem-autenticacao', async () => {
    await initiate(
      { fileName: 'aula.mp4', size: 1024, contentType: 'video/mp4' },
      false,
    ).expect(401);

    expect(await ctx.dataSource.getRepository(Video).count()).toBe(0);
  });

  it('initiate-public-id-unico-sem-id-interno', async () => {
    const body = { fileName: 'aula.mp4', size: 1024, contentType: 'video/mp4' };
    const first = await initiate(body).expect(201);
    const second = await initiate(body).expect(201);

    for (const res of [first, second]) {
      expect(res.body.publicId).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(res.body).not.toHaveProperty('id');
      expect(JSON.stringify(res.body)).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
      );
    }
    expect(first.body.publicId).not.toBe(second.body.publicId);
  });

  it('initiate-persiste-no-canal-do-caller', async () => {
    const res = await initiate({
      fileName: 'intro.webm',
      size: 2048,
      contentType: 'video/webm',
      title: '  Minha intro  ',
    }).expect(201);
    expect(res.body.title).toBe('Minha intro');

    const [{ channel_id }] = await ctx.dataSource.query<
      { channel_id: string }[]
    >(
      `SELECT c.id AS channel_id FROM "channels" c
       JOIN "users" u ON u.id = c.user_id WHERE u.email = $1`,
      ['uploader@example.com'],
    );
    const video = await ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: res.body.publicId });
    expect(video.channel_id).toBe(channel_id);
    expect(video.upload_id).not.toBeNull();
    expect(video.part_size).toBe(67108864);

    const parts = await s3.send(
      new ListPartsCommand({
        Bucket: bucket,
        Key: `videos/${video.id}/original`,
        UploadId: video.upload_id!,
      }),
    );
    expect(parts.Parts ?? []).toHaveLength(0);
  });
});
