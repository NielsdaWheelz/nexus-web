declare const MEDIA_IMAGE_PROXY_SRC: unique symbol;

export type MediaImageProxySrc = string & {
  readonly [MEDIA_IMAGE_PROXY_SRC]: true;
};

const PREFIX = "/api/media/image?url=";

export function buildMediaImageProxySrc(url: string): MediaImageProxySrc {
  return `${PREFIX}${encodeURIComponent(url)}` as MediaImageProxySrc;
}

// Both the client (encodeURIComponent) and the server (Python quote(safe=""))
// emit the `url` parameter using only unreserved characters plus %XX escapes,
// but they disagree on the sub-delims !*'() — the client leaves them literal,
// the server percent-encodes them. Validate on that shared alphabet rather than
// on byte-identical re-encoding, which would reject every server URL containing
// those characters (Wikimedia/CDN thumbnails routinely do).
const ENCODED_URL_PARAM = /^(?:[A-Za-z0-9._~!*'()-]|%[0-9A-Fa-f]{2})+$/;

export function parseMediaImageProxySrc(value: string): MediaImageProxySrc {
  if (!value.startsWith(PREFIX)) {
    throw new TypeError("Media image proxy source has invalid path");
  }
  const encoded = value.slice(PREFIX.length);
  if (!ENCODED_URL_PARAM.test(encoded)) {
    throw new TypeError("Media image proxy source has invalid encoding");
  }
  let remoteUrl: string;
  try {
    remoteUrl = decodeURIComponent(encoded);
  } catch {
    throw new TypeError("Media image proxy source has invalid encoding");
  }
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    throw new TypeError("Media image proxy source is not an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("Media image proxy source must be http(s)");
  }
  return value as MediaImageProxySrc;
}
