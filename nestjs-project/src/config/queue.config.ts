import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  // Key namespace; test runs use their own so a running worker never sees their jobs.
  prefix: process.env.QUEUE_PREFIX || 'bull',
}));
