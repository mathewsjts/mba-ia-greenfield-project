// Client for every server-side operation (container-to-container endpoint).
export const S3_INTERNAL_CLIENT = Symbol('S3_INTERNAL_CLIENT');
// Client used only to sign URLs handed to external clients (public endpoint).
export const S3_PUBLIC_CLIENT = Symbol('S3_PUBLIC_CLIENT');
