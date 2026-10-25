import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { VIDEO_PROCESSING_QUEUE } from '../queue/queue.constants';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';

// Videos domain without the HTTP layer: shared by the API (VideosModule) and
// the video worker (VideoProcessingModule).
@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    // Producer side of the queue; the video-worker consumes it.
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    StorageModule,
    ChannelsModule,
  ],
  providers: [VideosService],
  exports: [VideosService],
})
export class VideosCoreModule {}
