import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import request from 'supertest';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/queue.constants';
import { StorageObjectNotFoundError } from '../src/storage/storage.errors';
import { originalKey } from '../src/storage/storage-keys';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video } from '../src/videos/entities/video.entity';
import {
  VideosTestContext,
  abortOpenUploads,
  createAuthenticatedUser,
  createVideosTestApp,
  resetThrottler,
} from './utils/videos-e2e';

const MIB = 1024 * 1024;
const DECLARED_SIZE = 7340032; // 2 parts of 5 MiB + 2 MiB
const ACTIVE_STATES = ['waiting', 'delayed', 'active'] as const;

interface CompletedPart {
  partNumber: number;
  etag: string;
}

describe('videos-upload-complete', () => {
  let ctx: VideosTestContext;
  let queue: Queue;
  let ownerToken: string;
  let otherToken: string;

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
  const findVideo = (publicId: string) =>
    ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });
  const activeJobs = () => queue.getJobs([...ACTIVE_STATES]);

  async function createDraft(): Promise<string> {
    const res = await http()
      .post('/videos')
      .set(bearer(ownerToken))
      .send({
        fileName: 'aula.mp4',
        size: DECLARED_SIZE,
        contentType: 'video/mp4',
      })
      .expect(201);
    return res.body.publicId as string;
  }

  async function uploadAllParts(
    publicId: string,
    sizes: number[],
  ): Promise<CompletedPart[]> {
    const signed = await http()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set(bearer(ownerToken))
      .send({ partNumbers: sizes.map((_, index) => index + 1) })
      .expect(200);
    const parts: CompletedPart[] = [];
    for (const [index, part] of (
      signed.body.parts as { partNumber: number; url: string }[]
    ).entries()) {
      const put = await fetch(part.url, {
        method: 'PUT',
        body: new Uint8Array(Buffer.alloc(sizes[index], index + 1)),
      });
      expect(put.status).toBe(200);
      parts.push({
        partNumber: part.partNumber,
        etag: put.headers.get('etag')!,
      });
    }
    return parts;
  }

  const complete = (publicId: string, body: unknown, token = ownerToken) =>
    http()
      .post(`/videos/${publicId}/upload/complete`)
      .set(bearer(token))
      .send(body as object);

  beforeAll(async () => {
    ctx = await createVideosTestApp({ partSizeBytes: 5242880 });
    queue = ctx.app.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await abortOpenUploads(ctx);
    await queue.obliterate({ force: true });
    await ctx.app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads(ctx);
    await queue.obliterate({ force: true });
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx.app);
    ownerToken = await createAuthenticatedUser(ctx, 'owner@example.com');
    otherToken = await createAuthenticatedUser(ctx, 'other@example.com');
  });

  // 1. Conclusão do upload e enfileiramento do processamento

  it('complete-move-para-processing-e-enfileira', async () => {
    const publicId = await createDraft();
    const parts = await uploadAllParts(publicId, [5 * MIB, 2 * MIB]);

    const res = await complete(publicId, { parts }).expect(202);
    expect(res.body).toMatchObject({
      processingStatus: 'processing',
      status: 'draft',
    });

    const video = await findVideo(publicId);
    expect(video.processing_status).toBe('processing');
    expect(video.upload_id).toBeNull();
    await expect(
      ctx.storage.headObject(originalKey(video.id)),
    ).resolves.toMatchObject({ contentLength: DECLARED_SIZE });

    const jobs = await activeJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('process-video');
    expect(jobs[0].id).toBe(video.id);
    expect(jobs[0].data).toEqual({ videoId: video.id });
    expect(jobs[0].opts.attempts).toBe(3);
    expect(jobs[0].opts.backoff).toEqual({ type: 'exponential', delay: 5000 });

    await ctx.storage.deleteObject(originalKey(video.id));
  });

  it('complete-faltando-parte', async () => {
    const publicId = await createDraft();
    const [first] = await uploadAllParts(publicId, [5 * MIB]);

    const res = await complete(publicId, { parts: [first] }).expect(400);
    expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
    const video = await findVideo(publicId);
    expect(video.processing_status).toBe('awaiting_upload');
    expect(video.upload_id).not.toBeNull();
    expect(await activeJobs()).toHaveLength(0);

    const empty = await complete(publicId, { parts: [] }).expect(400);
    expect(empty.body.error).toBe('VALIDATION_ERROR');
  });

  it('complete-etag-incorreto', async () => {
    const publicId = await createDraft();
    const [first, second] = await uploadAllParts(publicId, [5 * MIB, 2 * MIB]);

    const res = await complete(publicId, {
      parts: [first, { ...second, etag: '"00000000000000000000000000000000"' }],
    }).expect(400);

    expect(res.body.error).toBe('INVALID_UPLOAD_PARTS');
    expect((await findVideo(publicId)).processing_status).toBe(
      'awaiting_upload',
    );
    expect(await activeJobs()).toHaveLength(0);
  });

  it('complete-tamanho-divergente', async () => {
    const publicId = await createDraft();
    const parts = await uploadAllParts(publicId, [5 * MIB, 1 * MIB]);

    const res = await complete(publicId, { parts }).expect(422);
    expect(res.body.error).toBe('UPLOAD_SIZE_MISMATCH');

    const video = await findVideo(publicId);
    await expect(
      ctx.storage.headObject(originalKey(video.id)),
    ).rejects.toBeInstanceOf(StorageObjectNotFoundError);
    expect(video.processing_status).toBe('failed');
    expect(video.failure_reason).toBe('size_mismatch');
    expect(await activeJobs()).toHaveLength(0);
  });

  it('complete-repetido-nao-duplica-job', async () => {
    const publicId = await createDraft();
    const parts = await uploadAllParts(publicId, [5 * MIB, 2 * MIB]);
    await complete(publicId, { parts }).expect(202);

    const again = await complete(publicId, { parts }).expect(409);
    expect(again.body.error).toBe('VIDEO_NOT_AWAITING_UPLOAD');
    expect(await activeJobs()).toHaveLength(1);

    const other = await complete(publicId, { parts }, otherToken).expect(404);
    expect(other.body.error).toBe('VIDEO_NOT_FOUND');

    await ctx.storage.deleteObject(originalKey((await findVideo(publicId)).id));
  });

  it('complete-multipart-expirado', async () => {
    const publicId = await createDraft();
    const parts = await uploadAllParts(publicId, [5 * MIB, 2 * MIB]);
    const draft = await findVideo(publicId);
    await ctx.storage.abortMultipartUpload(
      originalKey(draft.id),
      draft.upload_id!,
    );

    const res = await complete(publicId, { parts }).expect(410);
    expect(res.body.error).toBe('UPLOAD_EXPIRED');

    const video = await findVideo(publicId);
    expect(video.processing_status).toBe('failed');
    expect(video.failure_reason).toBe('upload_expired');
    expect(await activeJobs()).toHaveLength(0);
  });
});
