import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import { S3_INTERNAL_CLIENT, S3_PUBLIC_CLIENT } from './storage.constants';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from './storage.errors';

export interface UploadedPart {
  partNumber: number;
  etag: string;
  size: number;
}

export interface CompletedPart {
  partNumber: number;
  etag: string;
}

export interface PresignGetOptions {
  // 'public' URLs are handed to clients; 'internal' URLs are used by the worker.
  audience: 'public' | 'internal';
  expiresInSeconds: number;
  contentDisposition?: string;
}

const INVALID_PARTS_ERRORS = new Set([
  'InvalidPart',
  'InvalidPartOrder',
  'EntityTooSmall',
]);
const OBJECT_NOT_FOUND_ERRORS = new Set(['NotFound', 'NoSuchKey']);

function errorName(err: unknown): string | undefined {
  return err instanceof Error ? err.name : undefined;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly bucket: string;

  constructor(
    @Inject(S3_INTERNAL_CLIENT) private readonly internalClient: S3Client,
    @Inject(S3_PUBLIC_CLIENT) private readonly publicClient: S3Client,
    @Inject(storageConfig.KEY) config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
  }

  onModuleDestroy(): void {
    this.internalClient.destroy();
    this.publicClient.destroy();
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const result = await this.internalClient.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!result.UploadId) {
      throw new Error(`Storage did not return an UploadId for ${key}`);
    }
    return result.UploadId;
  }

  presignUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    return getSignedUrl(
      this.publicClient,
      new UploadPartCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiresInSeconds },
    );
  }

  async listParts(key: string, uploadId: string): Promise<UploadedPart[]> {
    const parts: UploadedPart[] = [];
    let marker: string | undefined;
    try {
      do {
        const page = await this.internalClient.send(
          new ListPartsCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
          }),
        );
        for (const part of page.Parts ?? []) {
          parts.push({
            partNumber: part.PartNumber ?? 0,
            etag: part.ETag ?? '',
            size: part.Size ?? 0,
          });
        }
        marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
      } while (marker);
    } catch (err) {
      throw this.mapUploadError(err, uploadId);
    }
    return parts.sort((a, b) => a.partNumber - b.partNumber);
  }

  // Presigning never contacts storage, so callers check the upload is still open.
  async assertUploadExists(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new ListPartsCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MaxParts: 1,
        }),
      );
    } catch (err) {
      throw this.mapUploadError(err, uploadId);
    }
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.internalClient.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((part) => ({
                PartNumber: part.partNumber,
                ETag: part.etag,
              })),
          },
        }),
      );
    } catch (err) {
      const name = errorName(err);
      if (name && INVALID_PARTS_ERRORS.has(name)) {
        throw new StorageInvalidPartsError(name);
      }
      throw this.mapUploadError(err, uploadId);
    }
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.internalClient.send(
        new AbortMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
        }),
      );
    } catch (err) {
      throw this.mapUploadError(err, uploadId);
    }
  }

  async headObject(
    key: string,
  ): Promise<{ contentLength: number; contentType?: string }> {
    try {
      const result = await this.internalClient.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        contentLength: result.ContentLength ?? 0,
        contentType: result.ContentType,
      };
    } catch (err) {
      const name = errorName(err);
      if (name && OBJECT_NOT_FOUND_ERRORS.has(name)) {
        throw new StorageObjectNotFoundError(key);
      }
      throw err;
    }
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.internalClient.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.internalClient.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  presignGetObject(key: string, options: PresignGetOptions): Promise<string> {
    const client =
      options.audience === 'public' ? this.publicClient : this.internalClient;
    return getSignedUrl(
      client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: options.contentDisposition,
      }),
      { expiresIn: options.expiresInSeconds },
    );
  }

  private mapUploadError(err: unknown, uploadId: string): unknown {
    return errorName(err) === 'NoSuchUpload'
      ? new StorageUploadNotFoundError(uploadId)
      : err;
  }
}
