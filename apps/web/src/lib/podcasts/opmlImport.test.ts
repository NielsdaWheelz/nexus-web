import { describe, expect, it, vi } from "vitest";
import {
  decodePodcastOpmlImportResponse,
  getPodcastOpmlFileError,
  importPodcastOpml,
  PodcastOpmlContractDefect,
  PodcastOpmlEncodingError,
} from "./opmlImport";

describe("getPodcastOpmlFileError", () => {
  it("accepts OPML/XML by owned filename or XML media type", () => {
    expect(
      getPodcastOpmlFileError(
        new File(["<opml />"], "feeds.opml", {
          type: "application/octet-stream",
        }),
      ),
    ).toBeNull();
    expect(
      getPodcastOpmlFileError(
        new File(["<opml />"], "feeds", { type: "application/xml" }),
      ),
    ).toBeNull();
  });

  it("rejects an arbitrary octet-stream, empty input, and oversized input", () => {
    expect(
      getPodcastOpmlFileError(
        new File(["not opml"], "feeds.bin", {
          type: "application/octet-stream",
        }),
      ),
    ).toBe("Choose an OPML or XML file.");
    expect(
      getPodcastOpmlFileError(
        new File([], "feeds.opml", { type: "application/xml" }),
      ),
    ).toBe("OPML files must not be empty.");
    const oversized = new File(["x"], "feeds.xml", { type: "application/xml" });
    Object.defineProperty(oversized, "size", { value: 1_000_001 });
    expect(getPodcastOpmlFileError(oversized)).toBe(
      "OPML files must be 1 MB or smaller.",
    );
  });
});

describe("decodePodcastOpmlImportResponse", () => {
  it("decodes exact counters and keeps issues separate", () => {
    expect(
      decodePodcastOpmlImportResponse({
        data: {
          total: 5,
          imported: 2,
          skipped_already_subscribed: 1,
          skipped_invalid: 1,
          errors: [{ feed_url: null, error: "Post-success issue" }],
        },
      }),
    ).toEqual({
      total: 5,
      imported: 2,
      skipped_already_subscribed: 1,
      skipped_invalid: 1,
      errors: [{ feed_url: null, error: "Post-success issue" }],
    });
  });

  it("defects on malformed same-system counters", () => {
    expect(() =>
      decodePodcastOpmlImportResponse({
        data: {
          total: -1,
          imported: 0,
          skipped_already_subscribed: 0,
          skipped_invalid: 0,
          errors: [],
        },
      }),
    ).toThrow(PodcastOpmlContractDefect);
    expect(() =>
      decodePodcastOpmlImportResponse({
        data: {
          total: 2,
          imported: 1,
          skipped_already_subscribed: 1,
          skipped_invalid: 1,
          errors: [],
        },
      }),
    ).toThrow("classified outcomes exceed total");
  });
});

describe("importPodcastOpml", () => {
  it("rejects malformed UTF-8 bytes before the JSON API boundary", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const file = new File([new Uint8Array([0xc3, 0x28])], "feeds.opml", {
      type: "text/xml",
    });

    await expect(
      importPodcastOpml({ file, libraryIds: [] }),
    ).rejects.toBeInstanceOf(PodcastOpmlEncodingError);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
