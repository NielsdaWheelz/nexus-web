import { describe, expect, it } from "vitest";
import {
  buildMediaImageProxySrc,
  parseMediaImageProxySrc,
} from "./imageProxy";

describe("buildMediaImageProxySrc", () => {
  it("encodes remote image URLs for the media image proxy", () => {
    expect(
      buildMediaImageProxySrc("https://cdn.example.com/covers/show art.jpg?size=large"),
    ).toBe(
      "/api/media/image?url=https%3A%2F%2Fcdn.example.com%2Fcovers%2Fshow%20art.jpg%3Fsize%3Dlarge",
    );
  });

  it("encodes already-local paths instead of treating them as proxy routes", () => {
    expect(buildMediaImageProxySrc("/api/media/image")).toBe(
      "/api/media/image?url=%2Fapi%2Fmedia%2Fimage",
    );
  });
});

describe("parseMediaImageProxySrc", () => {
  const wikimediaUrl =
    "https://upload.wikimedia.org/wikipedia/commons/Foo_(bar)!'*.jpg";

  it("accepts the server encoding, which percent-encodes !*'() unlike the client", () => {
    // The Python server emits quote(url, safe=""); the client encodeURIComponent
    // leaves !*'() literal. Both must decode to the same proxy source.
    const serverSrc =
      "/api/media/image?url=https%3A%2F%2Fupload.wikimedia.org%2Fwikipedia%2Fcommons%2FFoo_%28bar%29%21%27%2A.jpg";
    expect(parseMediaImageProxySrc(serverSrc)).toBe(serverSrc);
  });

  it("accepts the client encoding of the same URL", () => {
    const clientSrc = buildMediaImageProxySrc(wikimediaUrl);
    expect(parseMediaImageProxySrc(clientSrc)).toBe(clientSrc);
  });

  it("rejects a source outside the proxy path", () => {
    expect(() => parseMediaImageProxySrc("https://evil.example/x.jpg")).toThrow(
      /invalid path/,
    );
  });

  it("rejects a url parameter that could escape the query string", () => {
    expect(() =>
      parseMediaImageProxySrc("/api/media/image?url=https://a&x=b"),
    ).toThrow(/invalid encoding/);
  });

  it("rejects a decoded value that is not an absolute http(s) URL", () => {
    expect(() =>
      parseMediaImageProxySrc("/api/media/image?url=%2Frelative%2Fpath.jpg"),
    ).toThrow(/absolute URL/);
  });
});
