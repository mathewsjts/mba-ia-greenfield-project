import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_PUBLIC_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY: 'access',
  STORAGE_SECRET_KEY: 'secret-key',
  STORAGE_BUCKET: 'bucket',
  REDIS_HOST: 'redis',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage, queue and upload keys', () => {
  it.each([
    'STORAGE_ENDPOINT',
    'STORAGE_PUBLIC_ENDPOINT',
    'STORAGE_ACCESS_KEY',
    'STORAGE_SECRET_KEY',
    'STORAGE_BUCKET',
    'REDIS_HOST',
  ])('should reject the environment when %s is missing', (key) => {
    const env: Record<string, unknown> = { ...requiredEnv };
    delete env[key];

    const { error } = envValidationSchema.validate(env, {
      allowUnknown: true,
      abortEarly: false,
    });

    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should reject UPLOAD_PART_SIZE_BYTES below the 5 MiB S3 part minimum', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '1048576' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('UPLOAD_PART_SIZE_BYTES');
  });

  it('should accept UPLOAD_PART_SIZE_BYTES at exactly 5 MiB', () => {
    const { error } = validate({ UPLOAD_PART_SIZE_BYTES: '5242880' });
    expect(error).toBeUndefined();
  });

  it('should apply defaults for upload, delivery, region and Redis port', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.UPLOAD_PART_SIZE_BYTES).toBe(67108864);
    expect(value.UPLOAD_PART_URL_EXPIRES_SECONDS).toBe(900);
    expect(value.MEDIA_URL_EXPIRES_SECONDS).toBe(3600);
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.REDIS_PORT).toBe(6379);
  });
});
