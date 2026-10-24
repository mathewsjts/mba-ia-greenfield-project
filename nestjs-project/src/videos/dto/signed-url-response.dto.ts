import { ApiProperty } from '@nestjs/swagger';

export class SignedUrlResponseDto {
  @ApiProperty({
    description:
      'Short-lived presigned storage URL; fetch it directly (supports HTTP Range)',
  })
  url: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt: string;
}
