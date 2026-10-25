import request from 'supertest';
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
const PART_SIZES = [5 * MIB, 2 * MIB];

describe('videos-upload-parts', () => {
  let ctx: VideosTestContext;
  let ownerToken: string;
  let otherToken: string;

  const http = () => request(ctx.app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createDraft(): Promise<string> {
    const res = await http()
      .post('/videos')
      .set(bearer(ownerToken))
      .send({ fileName: 'aula.mp4', size: 7340032, contentType: 'video/mp4' })
      .expect(201);
    expect(res.body.upload).toEqual({ partSize: 5242880, partCount: 2 });
    return res.body.publicId as string;
  }

  async function putPart(url: string, bytes: number): Promise<Response> {
    return fetch(url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.alloc(bytes, 9)),
    });
  }

  const findVideo = (publicId: string) =>
    ctx.dataSource
      .getRepository(Video)
      .findOneByOrFail({ public_id: publicId });

  beforeAll(async () => {
    ctx = await createVideosTestApp({ partSizeBytes: 5242880 });
  });

  afterAll(async () => {
    await abortOpenUploads(ctx);
    await ctx.app.close();
  });

  beforeEach(async () => {
    await abortOpenUploads(ctx);
    await cleanAllTables(ctx.dataSource);
    resetThrottler(ctx.app);
    ownerToken = await createAuthenticatedUser(ctx, 'owner@example.com');
    otherToken = await createAuthenticatedUser(ctx, 'other@example.com');
  });

  // 1. URLs presignadas, retomada e cancelamento do upload

  it('part-urls-emite-urls-utilizaveis', async () => {
    const publicId = await createDraft();
    const before = Date.now();

    const res = await http()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set(bearer(ownerToken))
      .send({ partNumbers: [2, 1] })
      .expect(200);

    expect(
      res.body.parts.map((p: { partNumber: number }) => p.partNumber),
    ).toEqual([1, 2]);
    const secondsAhead =
      (new Date(res.body.expiresAt).getTime() - before) / 1000;
    expect(secondsAhead).toBeGreaterThan(800);
    expect(secondsAhead).toBeLessThan(1000);

    for (const [index, part] of (
      res.body.parts as { url: string }[]
    ).entries()) {
      const put = await putPart(part.url, PART_SIZES[index]);
      expect(put.status).toBe(200);
      expect(put.headers.get('etag')).toBeTruthy();
    }
  });

  it('part-urls-numero-fora-do-range', async () => {
    const publicId = await createDraft();
    const url = `/videos/${publicId}/upload/part-urls`;

    const outOfRange = await http()
      .post(url)
      .set(bearer(ownerToken))
      .send({ partNumbers: [3] })
      .expect(400);
    expect(outOfRange.body.error).toBe('INVALID_PART_NUMBER');

    for (const partNumbers of [[0], [], [1, 1]]) {
      const invalid = await http()
        .post(url)
        .set(bearer(ownerToken))
        .send({ partNumbers })
        .expect(400);
      expect(invalid.body.error).toBe('VALIDATION_ERROR');
    }
  });

  it('list-parts-reflete-partes-enviadas', async () => {
    const publicId = await createDraft();
    const partsUrl = `/videos/${publicId}/upload/parts`;

    const empty = await http()
      .get(partsUrl)
      .set(bearer(ownerToken))
      .expect(200);
    expect(empty.body).toEqual({ parts: [] });

    const signed = await http()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set(bearer(ownerToken))
      .send({ partNumbers: [1, 2] })
      .expect(200);
    const etags: string[] = [];
    for (const [index, part] of (
      signed.body.parts as { url: string }[]
    ).entries()) {
      etags.push(
        (await putPart(part.url, PART_SIZES[index])).headers.get('etag')!,
      );
    }

    const listed = await http()
      .get(partsUrl)
      .set(bearer(ownerToken))
      .expect(200);
    expect(listed.body.parts).toEqual([
      { partNumber: 1, etag: etags[0], size: 5242880 },
      { partNumber: 2, etag: etags[1], size: 2097152 },
    ]);
  });

  it('abort-marca-upload-aborted', async () => {
    const publicId = await createDraft();

    await http()
      .delete(`/videos/${publicId}/upload`)
      .set(bearer(ownerToken))
      .expect(204)
      .expect((res) => expect(res.text).toBe(''));

    const video = await findVideo(publicId);
    expect(video.processing_status).toBe('failed');
    expect(video.failure_reason).toBe('upload_aborted');
    expect(video.upload_id).toBeNull();

    const again = await http()
      .post(`/videos/${publicId}/upload/part-urls`)
      .set(bearer(ownerToken))
      .send({ partNumbers: [1] })
      .expect(409);
    expect(again.body.error).toBe('VIDEO_NOT_AWAITING_UPLOAD');

    const secondAbort = await http()
      .delete(`/videos/${publicId}/upload`)
      .set(bearer(ownerToken))
      .expect(409);
    expect(secondAbort.body.error).toBe('VIDEO_NOT_AWAITING_UPLOAD');
  });

  it('multipart-expirado-marca-upload-expired', async () => {
    const expireInStorage = async (publicId: string) => {
      const video = await findVideo(publicId);
      await ctx.storage.abortMultipartUpload(
        originalKey(video.id),
        video.upload_id!,
      );
    };

    const listed = await createDraft();
    await expireInStorage(listed);
    const listRes = await http()
      .get(`/videos/${listed}/upload/parts`)
      .set(bearer(ownerToken))
      .expect(410);
    expect(listRes.body.error).toBe('UPLOAD_EXPIRED');
    const listedVideo = await findVideo(listed);
    expect(listedVideo.processing_status).toBe('failed');
    expect(listedVideo.failure_reason).toBe('upload_expired');

    const signed = await createDraft();
    await expireInStorage(signed);
    const signRes = await http()
      .post(`/videos/${signed}/upload/part-urls`)
      .set(bearer(ownerToken))
      .send({ partNumbers: [1] })
      .expect(410);
    expect(signRes.body.error).toBe('UPLOAD_EXPIRED');
  });

  it('nao-owner-recebe-404', async () => {
    const publicId = await createDraft();
    // Built lazily: each supertest request binds the server to its own port.
    const calls = (id: string) => [
      () =>
        http()
          .post(`/videos/${id}/upload/part-urls`)
          .send({ partNumbers: [1] }),
      () => http().get(`/videos/${id}/upload/parts`),
      () => http().delete(`/videos/${id}/upload`),
    ];

    const otherBodies: unknown[] = [];
    for (const call of calls(publicId)) {
      const res = await call().set(bearer(otherToken)).expect(404);
      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
      otherBodies.push(res.body);
    }
    expect((await findVideo(publicId)).processing_status).toBe(
      'awaiting_upload',
    );

    for (const [index, call] of calls('AAAAAAAAAAA').entries()) {
      const res = await call().set(bearer(ownerToken)).expect(404);
      expect(res.body).toEqual(otherBodies[index]);
    }

    for (const call of calls(publicId)) {
      await call().expect(401);
    }
  });
});
