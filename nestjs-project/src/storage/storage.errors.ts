export class StorageUploadNotFoundError extends Error {
  constructor(uploadId: string) {
    super(`Multipart upload ${uploadId} does not exist`);
    this.name = 'StorageUploadNotFoundError';
  }
}

export class StorageInvalidPartsError extends Error {
  constructor(reason: string) {
    super(`Multipart upload parts were rejected: ${reason}`);
    this.name = 'StorageInvalidPartsError';
  }
}

export class StorageObjectNotFoundError extends Error {
  constructor(key: string) {
    super(`Object ${key} does not exist`);
    this.name = 'StorageObjectNotFoundError';
  }
}
