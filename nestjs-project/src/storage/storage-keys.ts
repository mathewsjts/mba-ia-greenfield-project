export function originalKey(videoId: string): string {
  return `videos/${videoId}/original`;
}

export function thumbnailKey(videoId: string): string {
  return `videos/${videoId}/thumbnail.jpg`;
}
