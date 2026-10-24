import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import storageConfig from '../config/storage.config';
import { testStorageConfig } from '../test/storage-test-config';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';

const MIB = 1024 * 1024;

async function buildService(
  overrides: Parameters<typeof testStorageConfig>[0] = {},
): Promise<{ module: TestingModule; storage: StorageService }> {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
      StorageModule,
    ],
  })
    .overrideProvider(storageConfig.KEY)
    .useValue(testStorageConfig(overrides))
    .compile();
  return { module, storage: module.get(StorageService) };
}

async function putPart(url: string, body: Buffer): Promise<string> {
  const response = await fetch(url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  expect(response.status).toBe(200);
  const etag = response.headers.get('etag');
  expect(etag).toBeTruthy();
  return etag!;
}

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let storage: StorageService;
  const createdKeys: string[] = [];

  const newKey = () => {
    const key = `videos/test-${randomUUID()}/original`;
    createdKeys.push(key);
    return key;
  };

  beforeAll(async () => {
    ({ module, storage } = await buildService());
  });

  afterAll(async () => {
    await Promise.all(createdKeys.map((key) => storage.deleteObject(key)));
    await module.close();
  });

  it('should complete a multipart upload sent through presigned part URLs', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    const part1 = Buffer.alloc(5 * MIB, 1);
    const part2 = Buffer.alloc(1024, 2);

    const etag1 = await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 60),
      part1,
    );
    const etag2 = await putPart(
      await storage.presignUploadPart(key, uploadId, 2, 60),
      part2,
    );

    const listed = await storage.listParts(key, uploadId);
    expect(listed).toEqual([
      { partNumber: 1, etag: etag1, size: part1.length },
      { partNumber: 2, etag: etag2, size: part2.length },
    ]);

    await storage.completeMultipartUpload(key, uploadId, [
      { partNumber: 2, etag: etag2 },
      { partNumber: 1, etag: etag1 },
    ]);

    const head = await storage.headObject(key);
    expect(head.contentLength).toBe(part1.length + part2.length);
    expect(head.contentType).toBe('video/mp4');
  }, 30000);

  it('should reject a part list whose ETag does not match the stored part', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await putPart(
      await storage.presignUploadPart(key, uploadId, 1, 60),
      Buffer.alloc(1024, 3),
    );

    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"00000000000000000000000000000000"' },
      ]),
    ).rejects.toBeInstanceOf(StorageInvalidPartsError);

    await storage.abortMultipartUpload(key, uploadId);
  });

  it('should map operations on an aborted upload to StorageUploadNotFoundError', async () => {
    const key = newKey();
    const uploadId = await storage.createMultipartUpload(key, 'video/mp4');
    await storage.abortMultipartUpload(key, uploadId);

    await expect(storage.listParts(key, uploadId)).rejects.toBeInstanceOf(
      StorageUploadNotFoundError,
    );
    await expect(
      storage.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, etag: '"x"' },
      ]),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
  });

  it('should map a missing object to StorageObjectNotFoundError', async () => {
    await expect(storage.headObject(newKey())).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
  });

  describe('presigned GET', () => {
    let key: string;
    const body = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));

    beforeAll(async () => {
      key = newKey();
      await storage.putObject(key, body, 'video/mp4');
    });

    it('should serve byte ranges with 206 Partial Content', async () => {
      const url = await storage.presignGetObject(key, {
        audience: 'public',
        expiresInSeconds: 60,
      });

      const response = await fetch(url, {
        headers: { Range: 'bytes=0-1023' },
      });

      expect(response.status).toBe(206);
      const received = Buffer.from(await response.arrayBuffer());
      expect(received).toEqual(body.subarray(0, 1024));
    });

    it('should apply the requested Content-Disposition', async () => {
      const url = await storage.presignGetObject(key, {
        audience: 'public',
        expiresInSeconds: 60,
        contentDisposition: 'attachment; filename="aula.mp4"',
      });

      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toBe(
        'attachment; filename="aula.mp4"',
      );
    });
  });

  it('should sign client URLs for the public endpoint and worker URLs for the internal one', async () => {
    const { module: publicModule, storage: publicStorage } = await buildService(
      { publicEndpoint: 'http://public.example.test:9000' },
    );

    const partUrl = new URL(
      await publicStorage.presignUploadPart(newKey(), 'upload-id', 1, 60),
    );
    const publicGet = new URL(
      await publicStorage.presignGetObject('videos/x/original', {
        audience: 'public',
        expiresInSeconds: 60,
      }),
    );
    const internalGet = new URL(
      await publicStorage.presignGetObject('videos/x/original', {
        audience: 'internal',
        expiresInSeconds: 60,
      }),
    );

    expect(partUrl.host).toBe('public.example.test:9000');
    expect(publicGet.host).toBe('public.example.test:9000');
    expect(internalGet.hostname).toBe('minio');
    expect(partUrl.searchParams.has('x-amz-checksum-crc32')).toBe(false);
    expect(partUrl.searchParams.has('x-amz-sdk-checksum-algorithm')).toBe(
      false,
    );

    await publicModule.close();
  });
});
