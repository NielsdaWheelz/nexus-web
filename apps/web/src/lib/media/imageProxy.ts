declare const MEDIA_IMAGE_PROXY_SRC: unique symbol;

export type MediaImageProxySrc = string & {
  readonly [MEDIA_IMAGE_PROXY_SRC]: true;
};

const PREFIX = "/api/media/image?url=";

export function buildMediaImageProxySrc(url: string): MediaImageProxySrc {
  return `${PREFIX}${encodeURIComponent(url)}` as MediaImageProxySrc;
}

export function parseMediaImageProxySrc(value: string): MediaImageProxySrc {
  if (!value.startsWith(PREFIX)) {
    throw new TypeError("Media image proxy source has invalid path");
  }
  let remoteUrl: string;
  try {
    remoteUrl = decodeURIComponent(value.slice(PREFIX.length));
  } catch {
    throw new TypeError("Media image proxy source has invalid encoding");
  }
  if (buildMediaImageProxySrc(remoteUrl) !== value) {
    throw new TypeError("Media image proxy source is not canonical");
  }
  return value as MediaImageProxySrc;
}
