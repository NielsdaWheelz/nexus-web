import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchContributorDetail,
  fetchContributorSearch,
  fetchContributorWorks,
  patchContributorDisplayName,
  putMediaAuthors,
} from "./api";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: (path: string, init?: RequestInit) => Response) {
  const mock = vi.fn((path: string, init?: RequestInit) => Promise.resolve(handler(path, init)));
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("contributor api decode boundary", () => {
  it("requests a non-blank query with a limit and decodes branded search items", async () => {
    const mock = stubFetch((path) => {
      expect(path).toBe("/api/contributors?q=le+guin&limit=10");
      return jsonResponse({
        data: {
          contributors: [
            {
              handle: "ursula-le-guin",
              href: "/authors/ursula-le-guin",
              displayName: "Ursula K. Le Guin",
              workCount: 3,
              workExamples: [{ title: "A Wizard of Earthsea", href: "/media/1" }],
              matchedAlias: null,
            },
          ],
          nextCursor: "cursor-2",
        },
      });
    });

    const page = await fetchContributorSearch("  le guin  ", { limit: 10 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(page.nextCursor).toBe("cursor-2");
    expect(page.contributors[0]).toEqual({
      handle: "ursula-le-guin",
      href: "/authors/ursula-le-guin",
      displayName: "Ursula K. Le Guin",
      workCount: 3,
      workExamples: [{ title: "A Wizard of Earthsea", href: "/media/1" }],
      matchedAlias: null,
    });
  });

  it("defects when the wire returns a non-canonical handle", async () => {
    stubFetch(() =>
      jsonResponse({
        data: {
          contributors: [
            {
              handle: "Not A Handle",
              href: "/authors/x",
              displayName: "X",
              workCount: 0,
              workExamples: [],
              matchedAlias: null,
            },
          ],
          nextCursor: null,
        },
      }),
    );

    await expect(fetchContributorSearch("x")).rejects.toThrow(/invalid contributor handle/);
  });

  it("decodes contributor detail and brands the handle", async () => {
    stubFetch((path) => {
      expect(path).toBe("/api/contributors/ursula-le-guin");
      return jsonResponse({
        data: {
          handle: "ursula-le-guin",
          href: "/authors/ursula-le-guin",
          displayName: "Ursula K. Le Guin",
          otherNames: ["U. K. Le Guin"],
          canRename: true,
        },
      });
    });

    const detail = await fetchContributorDetail("ursula-le-guin");
    expect(detail.handle).toBe("ursula-le-guin");
    expect(detail.otherNames).toEqual(["U. K. Le Guin"]);
    expect(detail.canRename).toBe(true);
  });

  it("decodes a works page with role facts and an opaque cursor", async () => {
    stubFetch((path) => {
      expect(path).toBe("/api/contributors/ursula-le-guin/works?cursor=abc");
      return jsonResponse({
        data: {
          works: [
            {
              title: "A Wizard of Earthsea",
              href: "/media/1",
              contentKind: "epub",
              date: "1968",
              roleFacts: [{ creditedName: "Ursula K. Le Guin", role: "author", rawRole: null }],
            },
          ],
          nextCursor: null,
        },
      });
    });

    const page = await fetchContributorWorks("ursula-le-guin", { cursor: "abc" });
    expect(page.works[0].roleFacts[0].role).toBe("author");
    expect(page.works[0].date).toEqual({ kind: "Present", value: "1968" });
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a malformed contributor-work publication date", async () => {
    stubFetch(() =>
      jsonResponse({
        data: {
          works: [
            {
              title: "Impossible",
              href: "/media/impossible",
              contentKind: "epub",
              date: "2025-02-29",
              roleFacts: [],
            },
          ],
          nextCursor: null,
        },
      }),
    );

    await expect(fetchContributorWorks("ursula-le-guin")).rejects.toThrow(
      /ContributorWorkItem.date/,
    );
  });

  it("PUTs a manual media-authors body and decodes branded author credits", async () => {
    const mock = stubFetch((path, init) => {
      expect(path).toBe("/api/media/media-1/authors");
      expect(init?.method).toBe("PUT");
      expect(JSON.parse(String(init?.body))).toEqual({
        clientMutationId: "cmid-1",
        mode: "manual",
        authors: [
          {
            creditedName: "U. K. Le Guin",
            binding: { kind: "existing", contributorHandle: "ursula-le-guin" },
          },
        ],
      });
      return jsonResponse({
        data: {
          authorMode: "manual",
          authors: [
            {
              contributorHandle: "ursula-le-guin",
              href: "/authors/ursula-le-guin",
              displayName: "Ursula K. Le Guin",
              creditedName: "U. K. Le Guin",
            },
          ],
          canEditAuthors: true,
        },
      });
    });

    const result = await putMediaAuthors("media-1", {
      clientMutationId: "cmid-1",
      mode: "manual",
      authors: [
        {
          creditedName: "U. K. Le Guin",
          binding: { kind: "existing", contributorHandle: "ursula-le-guin" as never },
        },
      ],
    });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.authorMode).toBe("manual");
    expect(result.authors[0].contributorHandle).toBe("ursula-le-guin");
  });

  it("PATCHes a rename and decodes the updated detail", async () => {
    stubFetch((path, init) => {
      expect(path).toBe("/api/contributors/ursula-le-guin");
      expect(init?.method).toBe("PATCH");
      return jsonResponse({
        data: {
          handle: "ursula-le-guin",
          href: "/authors/ursula-le-guin",
          displayName: "Ursula Le Guin",
          otherNames: [],
          canRename: true,
        },
      });
    });

    const detail = await patchContributorDisplayName("ursula-le-guin", {
      clientMutationId: "cmid-2",
      displayName: "Ursula Le Guin",
    });
    expect(detail.displayName).toBe("Ursula Le Guin");
  });
});
