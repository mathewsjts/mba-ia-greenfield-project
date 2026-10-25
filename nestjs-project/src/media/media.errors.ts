// ffprobe could not parse the input, or it has no video stream.
export class MediaUnreadableError extends Error {
  constructor(detail: string) {
    super(`Media could not be read: ${detail}`);
    this.name = 'MediaUnreadableError';
  }
}

export class MediaProcessTimeoutError extends Error {
  constructor(command: string, timeoutMs: number) {
    super(`${command} did not finish within ${timeoutMs} ms`);
    this.name = 'MediaProcessTimeoutError';
  }
}

export class MediaProcessFailedError extends Error {
  constructor(
    command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${command} exited with code ${exitCode}: ${stderr.trim()}`);
    this.name = 'MediaProcessFailedError';
  }
}
