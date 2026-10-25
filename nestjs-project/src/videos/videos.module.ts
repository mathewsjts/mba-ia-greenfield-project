import { Module } from '@nestjs/common';
import { VideosController } from './videos.controller';
import { VideosCoreModule } from './videos-core.module';

@Module({
  imports: [VideosCoreModule],
  controllers: [VideosController],
})
export class VideosModule {}
