import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoTooLargeException extends DomainException {
  constructor() {
    super(
      'VIDEO_TOO_LARGE',
      413,
      'Declared video size exceeds the 10 GiB limit',
    );
  }
}

export class UnsupportedVideoFormatException extends DomainException {
  constructor() {
    super(
      'UNSUPPORTED_VIDEO_FORMAT',
      415,
      'Only MP4 (.mp4, .m4v) and WebM (.webm) videos are accepted',
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotAwaitingUploadException extends DomainException {
  constructor() {
    super('VIDEO_NOT_AWAITING_UPLOAD', 409, 'Video is not awaiting upload');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor() {
    super(
      'INVALID_PART_NUMBER',
      400,
      'Part number exceeds the part count of this upload',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'Upload parts are incomplete or do not match the stored parts',
    );
  }
}

export class UploadExpiredException extends DomainException {
  constructor() {
    super('UPLOAD_EXPIRED', 410, 'The upload has expired or was aborted');
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'Uploaded size does not match the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}
