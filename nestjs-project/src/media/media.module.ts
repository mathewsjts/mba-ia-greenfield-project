import { Module } from '@nestjs/common';
import { MediaProbeService } from './media-probe.service';
import { MediaThumbnailService } from './media-thumbnail.service';

@Module({
  providers: [MediaProbeService, MediaThumbnailService],
  exports: [MediaProbeService, MediaThumbnailService],
})
export class MediaModule {}
