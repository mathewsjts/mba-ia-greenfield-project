import { registerAs } from '@nestjs/config';

export default registerAs('videos', () => ({
  partSizeBytes: parseInt(process.env.UPLOAD_PART_SIZE_BYTES || '67108864', 10),
  partUrlExpiresSeconds: parseInt(
    process.env.UPLOAD_PART_URL_EXPIRES_SECONDS || '900',
    10,
  ),
  mediaUrlExpiresSeconds: parseInt(
    process.env.MEDIA_URL_EXPIRES_SECONDS || '3600',
    10,
  ),
}));
