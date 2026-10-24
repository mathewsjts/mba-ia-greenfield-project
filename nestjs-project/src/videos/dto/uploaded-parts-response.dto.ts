import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({ example: '"5d41402abc4b2a76b9719d911017c592"' })
  etag: string;

  @ApiProperty({ example: 67108864, description: 'Bytes' })
  size: number;
}

export class UploadedPartsResponseDto {
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
