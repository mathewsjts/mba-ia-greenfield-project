import { ApiProperty } from '@nestjs/swagger';
import {
  Video,
  VideoProcessingStatus,
  VideoStatus,
} from '../entities/video.entity';

export class VideoResponseDto {
  @ApiProperty({
    example: 'Xk3_9aQ-0bZ',
    description: 'Public video identifier',
  })
  publicId: string;

  @ApiProperty({ example: 'aula' })
  title: string;

  @ApiProperty({ enum: VideoStatus, example: VideoStatus.Draft })
  status: VideoStatus;

  @ApiProperty({ enum: VideoProcessingStatus })
  processingStatus: VideoProcessingStatus;

  @ApiProperty({
    nullable: true,
    type: String,
    example: null,
    description:
      'unsupported_format | processing_error | size_mismatch | upload_expired | upload_aborted',
  })
  failureReason: string | null;

  @ApiProperty({ example: 'aula.mp4' })
  originalFileName: string;

  @ApiProperty({ enum: ['video/mp4', 'video/webm'] })
  contentType: string;

  @ApiProperty({ example: 10737418240 })
  sizeBytes: number;

  @ApiProperty({ nullable: true, type: Number, description: 'Seconds' })
  duration: number | null;

  @ApiProperty({ nullable: true, type: Number })
  width: number | null;

  @ApiProperty({ nullable: true, type: Number })
  height: number | null;

  @ApiProperty({ nullable: true, type: String, example: 'mp4' })
  container: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'h264' })
  videoCodec: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'aac' })
  audioCodec: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export function toVideoResponse(video: Video): VideoResponseDto {
  return {
    publicId: video.public_id,
    title: video.title,
    status: video.status,
    processingStatus: video.processing_status,
    failureReason: video.failure_reason,
    originalFileName: video.original_file_name,
    contentType: video.content_type,
    sizeBytes: video.size_bytes,
    duration: video.duration,
    width: video.width,
    height: video.height,
    container: video.container,
    videoCodec: video.video_codec,
    audioCodec: video.audio_codec,
    createdAt: video.created_at.toISOString(),
  };
}
