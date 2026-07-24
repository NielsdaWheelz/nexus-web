import { describe, expect, it } from "vitest";
import {
  decodePublicShareBootstrap,
  PublicShareContractDefect,
} from "./publicContract";

function bootstrap(sourceUrl: unknown) {
  return {
    data: {
      version: "V1",
      subject: { kind: "Media" },
      media: {
        title: "Document",
        media_kind: "Article",
        source_url: { kind: "Present", value: sourceUrl },
        bylines: [],
      },
      reader: { kind: "Article" },
    },
  };
}

describe("public source URL decoder", () => {
  it.each([
    "https://user@example.org/read",
    "https://user:password@example.org/read",
    "http://127.0.0.1/read",
    "http://[::1]/read",
    "http://2130706433/read",
    "http://localhost/read",
    "https://service.local/read",
    "https://example.org/read?token=secret",
    "https://example.org/read#fragment",
    "HTTPS://EXAMPLE.ORG/read",
    "https://Bücher.example.org/read",
  ])("rejects noncanonical or private source URL %s", (url) => {
    expect(() => decodePublicShareBootstrap(bootstrap(url))).toThrow(
      PublicShareContractDefect
    );
  });

  it.each([
    "https://example.org/read",
    "https://x.com/i/status/123",
    "https://www.youtube.com/watch?v=abcdefghijk",
    "https://arxiv.org/abs/2401.12345",
  ])("accepts canonical public source URL %s", (url) => {
    expect(
      decodePublicShareBootstrap(bootstrap(url)).media.sourceUrl
    ).toEqual({ kind: "Present", value: url });
  });
});
