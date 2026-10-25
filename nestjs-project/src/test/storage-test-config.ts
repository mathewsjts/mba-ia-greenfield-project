import type { ConfigType } from '@nestjs/config';
import storageConfig from '../config/storage.config';

// Tests run inside the nestjs-api container, where localhost:9000 does not
// reach MinIO — URLs signed for clients must target the container hostname.
export function testStorageConfig(
  overrides: Partial<ConfigType<typeof storageConfig>> = {},
): ConfigType<typeof storageConfig> {
  const base = storageConfig();
  return {
    ...base,
    publicEndpoint: base.endpoint,
    bucket: process.env.STORAGE_TEST_BUCKET || 'streamtube-videos-test',
    ...overrides,
  };
}
