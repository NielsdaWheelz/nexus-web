import { describe, expect, it } from "vitest";
import {
  buildMediaResourceHeader,
  classifyCanonicalMediaRefetchFailure,
  mapMediaAuthorCredits,
} from "./mediaFormatting";
import type { ContributorCredit } from "@/lib/contributors/types";
import { ApiError } from "@/lib/api/client";

describe("classifyCanonicalMediaRefetchFailure", () => {
  it("marks a canonical 404 or media-not-found code unavailable", () => {
    expect(
      classifyCanonicalMediaRefetchFailure(
        new ApiError(404, "E_MEDIA_NOT_FOUND", "gone"),
      ),
    ).toBe("unavailable");
    expect(
      classifyCanonicalMediaRefetchFailure(
        new ApiError(404, "E_UNKNOWN", "gone"),
      ),
    ).toBe("unavailable");
  });

  it("retains ready identity for not-ready and retryable failures", () => {
    expect(
      classifyCanonicalMediaRefetchFailure(
        new ApiError(404, "E_MEDIA_NOT_READY", "processing"),
      ),
    ).toBe("retain-ready");
    expect(
      classifyCanonicalMediaRefetchFailure(
        new ApiError(503, "E_UPSTREAM", "retry"),
      ),
    ).toBe("retain-ready");
    expect(classifyCanonicalMediaRefetchFailure(new Error("network"))).toBe(
      "retain-ready",
    );
  });
});

describe("buildMediaResourceHeader", () => {
  it("maps title and canonical ordered credit groups", () => {
    expect(buildMediaResourceHeader({
      title: "Dune",
      contributors: [
        { contributor_handle: "some-narrator", credited_name: "A Narrator", role: "narrator" },
        { contributor_handle: "frank-herbert", credited_name: "Frank Herbert", role: "author" },
        { contributor_handle: "brian", credited_name: "Brian Attebery", role: "author" },
        { contributor_handle: "margaret", credited_name: "Margaret Chodos-Irvine", role: "translator" },
      ],
    })).toEqual({
      status: "ready",
      title: "Dune",
      creditGroups: [
        {
          kind: "authors",
          credits: [
            { label: "Frank Herbert", href: "/authors/frank-herbert" },
            { label: "Brian Attebery", href: "/authors/brian" },
          ],
        },
        {
          kind: "role",
          label: "Translator",
          credits: [
            { label: "Margaret Chodos-Irvine", href: "/authors/margaret" },
          ],
        },
        {
          kind: "role",
          label: "Narrator",
          credits: [
            { label: "A Narrator", href: "/authors/some-narrator" },
          ],
        },
      ],
    });
  });
});

describe("mapMediaAuthorCredits", () => {
  const authorCredit: ContributorCredit = {
    contributor_handle: "frank-herbert",
    contributor_display_name: "Frank Herbert",
    credited_name: "Frank Herbert",
    role: "author",
    href: "/authors/frank-herbert",
  };

  it("maps resolved author credits and parses the branded handle at the boundary", () => {
    const rows = mapMediaAuthorCredits([authorCredit]);
    expect(rows).toEqual([
      {
        contributorHandle: "frank-herbert",
        href: "/authors/frank-herbert",
        displayName: "Frank Herbert",
        creditedName: "Frank Herbert",
      },
    ]);
  });

  it("drops non-author roles", () => {
    const rows = mapMediaAuthorCredits([
      { contributor_handle: "the-host", credited_name: "The Host", role: "host" },
      authorCredit,
    ]);
    expect(rows.map((row) => row.contributorHandle)).toEqual(["frank-herbert"]);
  });

  it("skips a handle-less author credit rather than seeding an empty-handle row (F5/D-45)", () => {
    // A handle-less author-role credit is an anomaly; force-casting "" into the
    // brand would seed a row whose Save 422s the whole slice. It must be skipped.
    const rows = mapMediaAuthorCredits([
      { credited_name: "Unresolved Person", role: "author" },
      authorCredit,
    ]);
    expect(rows.map((row) => row.creditedName)).toEqual(["Frank Herbert"]);
    expect(rows.every((row) => row.contributorHandle.length > 0)).toBe(true);
  });

  it("skips an author credit whose handle is non-canonical (reserved/invalid)", () => {
    const rows = mapMediaAuthorCredits([
      { contributor_handle: "directory", credited_name: "Reserved", role: "author" },
      { contributor_handle: "Bad Handle!", credited_name: "Invalid", role: "author" },
      authorCredit,
    ]);
    expect(rows.map((row) => row.contributorHandle)).toEqual(["frank-herbert"]);
  });

  it("falls back to the credited name and derived href when display/href are absent", () => {
    const rows = mapMediaAuthorCredits([
      { contributor_handle: "octavia-butler", credited_name: "O. E. Butler", role: "author" },
    ]);
    expect(rows).toEqual([
      {
        contributorHandle: "octavia-butler",
        href: "/authors/octavia-butler",
        displayName: "O. E. Butler",
        creditedName: "O. E. Butler",
      },
    ]);
  });
});
