import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  // Container-to-container endpoint, used for every server-side operation.
  endpoint: process.env.STORAGE_ENDPOINT || 'http://minio:9000',
  // Endpoint reachable by clients; only used to sign URLs handed to them.
  publicEndpoint:
    process.env.STORAGE_PUBLIC_ENDPOINT || 'http://localhost:9000',
  region: process.env.STORAGE_REGION || 'us-east-1',
  accessKey: process.env.STORAGE_ACCESS_KEY || '',
  secretKey: process.env.STORAGE_SECRET_KEY || '',
  bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
}));
