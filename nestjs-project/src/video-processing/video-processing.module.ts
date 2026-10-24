import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MediaModule } from '../media/media.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { VideosCoreModule } from '../videos/videos-core.module';
import { VideoProcessor } from './video.processor';

// Consumer side of the video-processing queue. Imported only by the
// video-worker's WorkerModule, never by AppModule, so the API never consumes.
@Module({
  imports: [
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    VideosCoreModule,
    StorageModule,
    MediaModule,
  ],
  providers: [VideoProcessor],
})
export class VideoProcessingModule {}
