import { describe, expect, it } from "vitest";
import { buildCompactMediaPaneTitle, mapMediaAuthorCredits } from "./mediaFormatting";
import type { ContributorCredit } from "@/lib/contributors/types";

describe("buildCompactMediaPaneTitle", () => {
  it("returns null for null input", () => {
    expect(buildCompactMediaPaneTitle(null)).toBeNull();
  });

  it("returns null for media with an empty title", () => {
    expect(buildCompactMediaPaneTitle({ title: "", contributors: [] })).toBeNull();
  });

  it("returns null for media with a whitespace-only title", () => {
    expect(buildCompactMediaPaneTitle({ title: "   ", contributors: [] })).toBeNull();
  });

  it("returns the title when there are no contributors", () => {
    const result = buildCompactMediaPaneTitle({ title: "Dune", contributors: [] });
    expect(result).toBe("Dune");
  });

  it("returns the compact title·author form when a contributor is present", () => {
    const contributor = {
      contributor_handle: "frank-herbert",
      credited_name: "Frank Herbert",
      role: "author",
    };
    const result = buildCompactMediaPaneTitle({ title: "Dune", contributors: [contributor] });
    expect(result).toBe("Dune · Frank Herbert");
  });

  it("uses the author role, not the first credit, for the compact title (D-23)", () => {
    const result = buildCompactMediaPaneTitle({
      title: "Dune",
      contributors: [
        { contributor_handle: "some-narrator", credited_name: "A Narrator", role: "narrator" },
        { contributor_handle: "frank-herbert", credited_name: "Frank Herbert", role: "author" },
      ],
    });
    expect(result).toBe("Dune · Frank Herbert");
  });

  it("returns the bare title when no author-role credit exists", () => {
    const result = buildCompactMediaPaneTitle({
      title: "Some Podcast Episode",
      contributors: [
        { contributor_handle: "the-host", credited_name: "The Host", role: "host" },
      ],
    });
    expect(result).toBe("Some Podcast Episode");
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
