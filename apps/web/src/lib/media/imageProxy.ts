export function buildMediaImageProxySrc(url: string): string {
  return `/api/media/image?url=${encodeURIComponent(url)}`;
}
