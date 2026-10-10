declare const MEDIA_IMAGE_PROXY_SRC: unique symbol;

export type MediaImageProxySrc = string & {
  readonly [MEDIA_IMAGE_PROXY_SRC]: true;
};

const PREFIX = "/api/media/image?url=";

export function buildMediaImageProxySrc(url: string): MediaImageProxySrc {
  return `${PREFIX}${encodeURIComponent(url)}` as MediaImageProxySrc;
}
