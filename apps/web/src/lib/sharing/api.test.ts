import { decodeShareSnapshot } from "@/lib/sharing/api";
import { describe, expect, it } from "vitest";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_HANDLE =
  "nrg1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";
const USER_HANDLE =
  "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
const TOKEN = `nxshr1_${"E".repeat(43)}`;

function snapshot() {
  return {
    data: {
      subject: `media:${MEDIA_ID}`,
      sharing: "ResourceGrants",
      authenticatedHref: `http://localhost:3000/media/${MEDIA_ID}`,
      creationAvailability: {
        user: { kind: "Available" },
        link: { kind: "Available" },
      },
      shares: [
        {
          kind: "User",
          handle: GRANT_HANDLE,
          user: {
            userHandle: USER_HANDLE,
            email: "reader@example.test",
            displayName: "Reader",
          },
        },
        {
          kind: "Link",
          handle: GRANT_HANDLE,
          publicHref: `http://localhost:3000/s#share=${TOKEN}`,
        },
      ],
      receivedAccess: [],
    },
  };
}

describe("decodeShareSnapshot", () => {
  it("accepts only canonical configured-origin links and sealed handles", () => {
    expect(decodeShareSnapshot(snapshot())).toMatchObject({
      subject: `media:${MEDIA_ID}`,
      authenticatedHref: `http://localhost:3000/media/${MEDIA_ID}`,
    });
  });

  it.each([
    [
      "artifact",
      `artifact:${MEDIA_ID}`,
      `http://localhost:3000/media/${MEDIA_ID}`,
    ],
    [
      "contributor",
      `contributor:${MEDIA_ID}`,
      "http://localhost:3000/authors/ada-lovelace",
    ],
  ])("accepts a canonical copy-only %s target", (_label, subject, href) => {
    const value = snapshot();
    expect(
      decodeShareSnapshot({
        data: {
          ...value.data,
          subject,
          sharing: "CopyOnly",
          authenticatedHref: href,
          creationAvailability: {
            user: { kind: "Unavailable", reason: "UnsupportedSubject" },
            link: { kind: "Unavailable", reason: "UnsupportedSubject" },
          },
          shares: [],
        },
      }),
    ).toMatchObject({ subject, sharing: "CopyOnly", authenticatedHref: href });
  });

  it.each([
    [
      "foreign authenticated origin",
      () => ({
        ...snapshot(),
        data: {
          ...snapshot().data,
          authenticatedHref: `https://attacker.example/media/${MEDIA_ID}`,
        },
      }),
    ],
    [
      "subject-path mismatch",
      () => ({
        ...snapshot(),
        data: {
          ...snapshot().data,
          authenticatedHref:
            "http://localhost:3000/media/22222222-2222-4222-8222-222222222222",
        },
      }),
    ],
    [
      "malformed highlight media path",
      () => ({
        ...snapshot(),
        data: {
          ...snapshot().data,
          subject: `highlight:${MEDIA_ID}`,
          sharing: "HighlightGrants",
          authenticatedHref:
            `http://localhost:3000/media/${"-".repeat(36)}#highlight-${MEDIA_ID}`,
        },
      }),
    ],
    [
      "public query credential",
      () => {
        const value = snapshot();
        return {
          data: {
            ...value.data,
            shares: value.data.shares.map((share) =>
              share.kind === "Link"
                ? {
                    ...share,
                    publicHref: `http://localhost:3000/s?share=${TOKEN}`,
                  }
                : share,
            ),
          },
        };
      },
    ],
    [
      "mode-subject mismatch",
      () => ({
        ...snapshot(),
        data: { ...snapshot().data, sharing: "CopyOnly" },
      }),
    ],
    [
      "grant rows in a non-grant mode",
      () => {
        const value = snapshot();
        return {
          data: {
            ...value.data,
            subject: `podcast:${MEDIA_ID}`,
            sharing: "CopyWithLibraryFiling",
            authenticatedHref: `http://localhost:3000/podcasts/${MEDIA_ID}`,
          },
        };
      },
    ],
    [
      "raw grant ID",
      () => {
        const value = snapshot();
        return {
          data: {
            ...value.data,
            shares: value.data.shares.map((share, index) =>
              index === 0 ? { ...share, handle: "raw-grant-id" } : share,
            ),
          },
        };
      },
    ],
  ])("rejects %s", (_label, build) => {
    expect(() => decodeShareSnapshot(build())).toThrow();
  });
});
