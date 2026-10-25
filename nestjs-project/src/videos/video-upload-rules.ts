// 10 GiB — the declared-size ceiling enforced before any storage call.
export const MAX_VIDEO_SIZE_BYTES = 10737418240;

export const MAX_TITLE_LENGTH = 100;

// Browser-playable containers only; codecs are verified later by ffprobe.
const EXTENSIONS_BY_CONTENT_TYPE: Record<string, readonly string[]> = {
  'video/mp4': ['.mp4', '.m4v'],
  'video/webm': ['.webm'],
};

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot).toLowerCase();
}

export function isAcceptedFormat(
  fileName: string,
  contentType: string,
): boolean {
  const extensions = EXTENSIONS_BY_CONTENT_TYPE[contentType];
  return extensions !== undefined && extensions.includes(extensionOf(fileName));
}

export function defaultTitle(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim();
  return base.slice(0, MAX_TITLE_LENGTH);
}

export function partCountFor(sizeBytes: number, partSizeBytes: number): number {
  return Math.ceil(sizeBytes / partSizeBytes);
}
