import { Inject, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';
import videosConfig from '../config/videos.config';
import { classifyFormat } from '../media/media-format';
import { MediaProbeService } from '../media/media-probe.service';
import {
  MediaThumbnailService,
  thumbnailOffset,
} from '../media/media-thumbnail.service';
import { MediaUnreadableError } from '../media/media.errors';
import {
  ProcessVideoJobData,
  VIDEO_PROCESSING_QUEUE,
} from '../queue/queue.constants';
import { originalKey, thumbnailKey } from '../storage/storage-keys';
import { StorageService } from '../storage/storage.service';
import { VideoProcessingStatus } from '../videos/entities/video.entity';
import { VideosService } from '../videos/videos.service';

@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);

  constructor(
    private readonly videosService: VideosService,
    private readonly storageService: StorageService,
    private readonly probeService: MediaProbeService,
    private readonly thumbnailService: MediaThumbnailService,
    @Inject(videosConfig.KEY)
    private readonly config: ConfigType<typeof videosConfig>,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videosService.findById(videoId);
    // Redelivery guard: only a video still in processing is worked on.
    if (video?.processing_status !== VideoProcessingStatus.Processing) {
      this.logger.warn(
        `Skipping job ${job.id}: video ${videoId} is not processing`,
      );
      return;
    }

    const key = originalKey(videoId);
    // A transient storage failure throws here and is retried; only an object that
    // exists but cannot be parsed is treated as a permanent format failure below.
    await this.storageService.headObject(key);
    const inputUrl = await this.storageService.presignGetObject(key, {
      audience: 'internal',
      expiresInSeconds: this.config.mediaUrlExpiresSeconds,
    });

    const probe = await this.probeOrReject(inputUrl);
    const format = classifyFormat(probe);
    if (!format.supported) {
      throw new UnrecoverableError(
        `Unsupported format: ${probe.formatName} / ${probe.videoCodec} / ${probe.audioCodec ?? 'no audio'}`,
      );
    }

    const jpeg = await this.thumbnailService.extractFrame(
      inputUrl,
      thumbnailOffset(probe.duration),
    );
    await this.storageService.putObject(
      thumbnailKey(videoId),
      jpeg,
      'image/jpeg',
    );

    await this.videosService.markReady(videoId, {
      duration: probe.duration,
      width: probe.width,
      height: probe.height,
      container: format.container,
      videoCodec: probe.videoCodec,
      audioCodec: probe.audioCodec,
    });
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<ProcessVideoJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const unrecoverable = error instanceof UnrecoverableError;
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    // Intermediate failures are retried by BullMQ; the DB only records the final one.
    if (!unrecoverable && !exhausted) return;

    try {
      await this.videosService.markProcessingFailed(
        job.data.videoId,
        unrecoverable ? 'unsupported_format' : 'processing_error',
      );
    } catch (err) {
      // Background context: rethrowing would crash the worker.
      this.logger.error(
        `Could not mark video ${job.data.videoId} as failed: ${String(err)}`,
      );
    }
  }

  private async probeOrReject(inputUrl: string) {
    try {
      return await this.probeService.probe(inputUrl);
    } catch (err) {
      if (err instanceof MediaUnreadableError) {
        throw new UnrecoverableError(err.message);
      }
      throw err;
    }
  }
}
