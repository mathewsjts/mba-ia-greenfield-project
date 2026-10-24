import { ApiProperty } from '@nestjs/swagger';

export class PartUrlDto {
  @ApiProperty({ example: 1 })
  partNumber: number;

  @ApiProperty({
    description: 'Presigned UploadPart URL — PUT the part bytes here',
  })
  url: string;
}

export class PartUrlsResponseDto {
  @ApiProperty({ type: [PartUrlDto] })
  parts: PartUrlDto[];

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
