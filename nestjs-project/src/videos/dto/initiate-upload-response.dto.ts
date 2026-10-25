import { ApiProperty } from '@nestjs/swagger';
import { VideoResponseDto } from './video-response.dto';

export class UploadInfoDto {
  @ApiProperty({ example: 67108864, description: 'Part size in bytes' })
  partSize: number;

  @ApiProperty({ example: 160, description: 'Number of parts to upload' })
  partCount: number;
}

export class InitiateUploadResponseDto extends VideoResponseDto {
  @ApiProperty({ type: UploadInfoDto })
  upload: UploadInfoDto;
}
