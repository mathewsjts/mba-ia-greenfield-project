import { Module } from '@nestjs/common';
import { RootConfigModule } from './config/root-config.module';
import { QueueModule } from './queue/queue.module';
import { UsersModule } from './users/users.module';
import { VideoProcessingModule } from './video-processing/video-processing.module';

// Application context of the video-worker process: no HTTP layer, consumes
// the video-processing queue.
@Module({
  imports: [
    RootConfigModule,
    QueueModule,
    VideoProcessingModule,
    // Registers the User entity: Channel (loaded via VideosModule) relates to it,
    // and TypeORM needs both sides of every relation in the connection.
    UsersModule,
  ],
})
export class WorkerModule {}
