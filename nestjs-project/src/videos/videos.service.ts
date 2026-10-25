import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import videosConfig from '../config/videos.config';
import {
  PROCESS_VIDEO_JOB,
  PROCESS_VIDEO_JOB_OPTIONS,
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import {
  StorageInvalidPartsError,
  StorageObjectNotFoundError,
  StorageUploadNotFoundError,
} from '../storage/storage.errors';
import {
  CompletedPart,
  StorageService,
  UploadedPart,
} from '../storage/storage.service';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import {
  Video,
  VideoFailureReason,
  VideoProcessingStatus,
} from './entities/video.entity';
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
import { generatePublicId, isPublicIdUniqueViolation } from './public-id';
import {
  MAX_VIDEO_SIZE_BYTES,
  defaultTitle,
  isAcceptedFormat,
  partCountFor,
} from './video-upload-rules';

const MAX_PUBLIC_ID_ATTEMPTS = 5;

// ASCII fallback plus the RFC 6266 UTF-8 form, so accented names survive.
function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function coversAllParts(parts: CompletedPart[], partCount: number): boolean {
  const numbers = new Set(parts.map((part) => part.partNumber));
  if (numbers.size !== parts.length || numbers.size !== partCount) {
    return false;
  }
  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    if (!numbers.has(partNumber)) return false;
  }
  return true;
}

export interface InitiatedUpload {
  video: Video;
  partCount: number;
}

export interface ProcessedMetadata {
  duration: number | null;
  width: number | null;
  height: number | null;
  container: string;
  videoCodec: string;
  audioCodec: string | null;
}

export type MediaKind = 'stream' | 'download' | 'thumbnail';

export interface SignedMediaUrl {
  url: string;
  expiresAt: string;
}

export interface PresignedParts {
  parts: { partNumber: number; url: string }[];
  expiresAt: string;
}

@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly channelsService: ChannelsService,
    private readonly storageService: StorageService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<ProcessVideoJobData>,
  ) {}

  async initiateUpload(
    userId: string,
    dto: InitiateUploadDto,
  ): Promise<InitiatedUpload> {
    if (dto.size > MAX_VIDEO_SIZE_BYTES) {
      throw new VideoTooLargeException();
    }
    if (!isAcceptedFormat(dto.fileName, dto.contentType)) {
      throw new UnsupportedVideoFormatException();
    }

    const channel = await this.channelsService.findByUserId(userId);
    if (!channel) {
      throw new Error(`User ${userId} has no channel`);
    }

    const partSize = this.config.partSizeBytes;
    const id = randomUUID();
    const key = originalKey(id);
    const uploadId = await this.storageService.createMultipartUpload(
      key,
      dto.contentType,
    );

    try {
      const video = await this.insertWithUniquePublicId({
        id,
        channel_id: channel.id,
        title: dto.title ?? defaultTitle(dto.fileName),
        original_file_name: dto.fileName,
        content_type: dto.contentType,
        size_bytes: dto.size,
        upload_id: uploadId,
        part_size: partSize,
      });
      return { video, partCount: partCountFor(dto.size, partSize) };
    } catch (err) {
      // Do not leave an orphan multipart upload behind a draft that was never saved.
      await this.storageService
        .abortMultipartUpload(key, uploadId)
        .catch((abortErr: unknown) =>
          this.logger.warn(
            `Could not abort multipart upload ${uploadId}: ${String(abortErr)}`,
          ),
        );
      throw err;
    }
  }

  findById(id: string): Promise<Video | null> {
    return this.videoRepository.findOneBy({ id });
  }

  // Both transitions only apply to a video still in processing, so a redelivered
  // job can never overwrite a terminal state.
  async markReady(id: string, metadata: ProcessedMetadata): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, processing_status: VideoProcessingStatus.Processing },
      {
        processing_status: VideoProcessingStatus.Ready,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        container: metadata.container,
        video_codec: metadata.videoCodec,
        audio_codec: metadata.audioCodec,
      },
    );
    return Boolean(result.affected);
  }

  async markProcessingFailed(
    id: string,
    reason: Extract<
      VideoFailureReason,
      'unsupported_format' | 'processing_error'
    >,
  ): Promise<boolean> {
    const result = await this.videoRepository.update(
      { id, processing_status: VideoProcessingStatus.Processing },
      {
        processing_status: VideoProcessingStatus.Failed,
        failure_reason: reason,
      },
    );
    return Boolean(result.affected);
  }

  async findOwnedOrFail(publicId: string, userId: string): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, channel: { user_id: userId } },
    });
    // Same response for "does not exist" and "not yours": ids are not leaked.
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  async getMediaUrl(
    publicId: string,
    userId: string,
    kind: MediaKind,
  ): Promise<SignedMediaUrl> {
    const video = await this.findOwnedOrFail(publicId, userId);
    if (video.processing_status !== VideoProcessingStatus.Ready) {
      throw new VideoNotReadyException();
    }

    const expiresIn = this.config.mediaUrlExpiresSeconds;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    // Signed for the public endpoint: the client fetches the bytes straight
    // from storage, which answers Range requests with 206.
    const url = await this.storageService.presignGetObject(
      kind === 'thumbnail' ? thumbnailKey(video.id) : originalKey(video.id),
      {
        audience: 'public',
        expiresInSeconds: expiresIn,
        contentDisposition:
          kind === 'download'
            ? attachmentDisposition(video.original_file_name)
            : undefined,
      },
    );
    return { url, expiresAt };
  }

  async requestPartUrls(
    publicId: string,
    userId: string,
    partNumbers: number[],
  ): Promise<PresignedParts> {
    const video = await this.findAwaitingUpload(publicId, userId);
    const partCount = partCountFor(video.size_bytes, video.part_size);
    if (partNumbers.some((partNumber) => partNumber > partCount)) {
      throw new InvalidPartNumberException();
    }

    const key = originalKey(video.id);
    await this.withUploadExpiry(video, () =>
      this.storageService.assertUploadExists(key, video.upload_id!),
    );

    const expiresIn = this.config.partUrlExpiresSeconds;
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    const sorted = [...partNumbers].sort((a, b) => a - b);
    const parts = await Promise.all(
      sorted.map(async (partNumber) => ({
        partNumber,
        url: await this.storageService.presignUploadPart(
          key,
          video.upload_id!,
          partNumber,
          expiresIn,
        ),
      })),
    );
    return { parts, expiresAt };
  }

  async listUploadedParts(
    publicId: string,
    userId: string,
  ): Promise<UploadedPart[]> {
    const video = await this.findAwaitingUpload(publicId, userId);
    return this.withUploadExpiry(video, () =>
      this.storageService.listParts(originalKey(video.id), video.upload_id!),
    );
  }

  async abortUpload(publicId: string, userId: string): Promise<void> {
    const video = await this.findAwaitingUpload(publicId, userId);
    try {
      await this.storageService.abortMultipartUpload(
        originalKey(video.id),
        video.upload_id!,
      );
    } catch (err) {
      // Already gone (expired or aborted elsewhere): the abort's goal is met.
      if (!(err instanceof StorageUploadNotFoundError)) throw err;
    }
    await this.markUploadFailed(video, 'upload_aborted');
  }

  async completeUpload(
    publicId: string,
    userId: string,
    parts: CompletedPart[],
  ): Promise<Video> {
    const video = await this.findAwaitingUpload(publicId, userId);
    const partCount = partCountFor(video.size_bytes, video.part_size);
    if (!coversAllParts(parts, partCount)) {
      throw new InvalidUploadPartsException();
    }

    const key = originalKey(video.id);
    await this.assembleUpload(video, key, parts);

    const { contentLength } = await this.storageService.headObject(key);
    if (contentLength !== video.size_bytes) {
      await this.storageService.deleteObject(key);
      await this.markUploadFailed(video, 'size_mismatch');
      throw new UploadSizeMismatchException();
    }

    const moved = await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.AwaitingUpload },
      { processing_status: VideoProcessingStatus.Processing, upload_id: null },
    );
    if (!moved.affected) {
      throw new VideoNotAwaitingUploadException();
    }

    try {
      // jobId = video id: a repeated enqueue for the same video is ignored.
      await this.processingQueue.add(
        PROCESS_VIDEO_JOB,
        { videoId: video.id },
        { ...PROCESS_VIDEO_JOB_OPTIONS, jobId: video.id },
      );
    } catch (err) {
      // Roll back so a retried complete can recover through the retry-safety path.
      await this.videoRepository.update(
        { id: video.id, processing_status: VideoProcessingStatus.Processing },
        {
          processing_status: VideoProcessingStatus.AwaitingUpload,
          upload_id: video.upload_id,
        },
      );
      throw err;
    }

    return this.videoRepository.findOneByOrFail({ id: video.id });
  }

  private async assembleUpload(
    video: Video,
    key: string,
    parts: CompletedPart[],
  ): Promise<void> {
    try {
      await this.storageService.completeMultipartUpload(
        key,
        video.upload_id!,
        parts,
      );
    } catch (err) {
      if (err instanceof StorageInvalidPartsError) {
        throw new InvalidUploadPartsException();
      }
      if (!(err instanceof StorageUploadNotFoundError)) throw err;
      // A previous call may have assembled the object and failed before the
      // DB update; proceed if the object exists, otherwise the upload expired.
      if (!(await this.objectExists(key))) {
        await this.markUploadFailed(video, 'upload_expired');
        throw new UploadExpiredException();
      }
    }
  }

  private async objectExists(key: string): Promise<boolean> {
    try {
      await this.storageService.headObject(key);
      return true;
    } catch (err) {
      if (err instanceof StorageObjectNotFoundError) return false;
      throw err;
    }
  }

  private async findAwaitingUpload(
    publicId: string,
    userId: string,
  ): Promise<Video> {
    const video = await this.findOwnedOrFail(publicId, userId);
    if (
      video.processing_status !== VideoProcessingStatus.AwaitingUpload ||
      !video.upload_id
    ) {
      throw new VideoNotAwaitingUploadException();
    }
    return video;
  }

  // Storage reporting NoSuchUpload means the multipart expired or was aborted.
  private async withUploadExpiry<T>(
    video: Video,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (err) {
      if (err instanceof StorageUploadNotFoundError) {
        await this.markUploadFailed(video, 'upload_expired');
        throw new UploadExpiredException();
      }
      throw err;
    }
  }

  private async markUploadFailed(
    video: Video,
    reason: VideoFailureReason,
  ): Promise<void> {
    await this.videoRepository.update(
      { id: video.id, processing_status: VideoProcessingStatus.AwaitingUpload },
      {
        processing_status: VideoProcessingStatus.Failed,
        failure_reason: reason,
        upload_id: null,
      },
    );
  }

  private async insertWithUniquePublicId(
    fields: Partial<Video>,
  ): Promise<Video> {
    for (let attempt = 1; attempt <= MAX_PUBLIC_ID_ATTEMPTS; attempt++) {
      try {
        return await this.videoRepository.save(
          this.videoRepository.create({
            ...fields,
            public_id: generatePublicId(),
          }),
        );
      } catch (err) {
        if (!isPublicIdUniqueViolation(err)) throw err;
      }
    }
    throw new Error(
      'Public id conflict could not be resolved after max retries',
    );
  }
}
