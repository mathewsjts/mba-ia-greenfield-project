import { randomBytes } from 'node:crypto';
import { QueryFailedError } from 'typeorm';

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';

// 8 random bytes → 11 base64url chars: short, URL-safe and unguessable.
export function generatePublicId(): string {
  return randomBytes(8).toString('base64url');
}

// QueryFailedError copies the pg driver error fields (code, detail) onto itself
interface PgErrorFields {
  code?: unknown;
  detail?: unknown;
}

export function isPublicIdUniqueViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const { code, detail } = err as QueryFailedError & PgErrorFields;
  return (
    code === PG_UNIQUE_VIOLATION &&
    typeof detail === 'string' &&
    detail.includes(PUBLIC_ID_COLUMN)
  );
}
