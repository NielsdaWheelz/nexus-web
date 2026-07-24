import { describe, expect, it } from "vitest";
import {
  decodeStandingActionTarget,
  routeResourceActionSubject,
} from "./resourceActionTarget";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

describe("decodeStandingActionTarget", () => {
  it("decodes exact Resource and External targets", () => {
    expect(
      decodeStandingActionTarget({
        kind: "Resource",
        ref: `media:${MEDIA_ID}`,
        activation: {
          resourceRef: `media:${MEDIA_ID}`,
          kind: "route",
          href: `/media/${MEDIA_ID}`,
          unresolvedReason: null,
        },
        missing: false,
      }),
    ).toMatchObject({
      kind: "Resource",
      ref: `media:${MEDIA_ID}`,
      activation: { href: `/media/${MEDIA_ID}` },
      missing: false,
    });
    expect(
      decodeStandingActionTarget({
        kind: "External",
        href: "/browse/gutenberg/84",
      }),
    ).toEqual({ kind: "External", href: "/browse/gutenberg/84" });
  });

  it.each([
    [
      "mismatched ref",
      {
        kind: "Resource",
        ref: `media:${MEDIA_ID}`,
        activation: {
          resourceRef: "podcast:22222222-2222-4222-8222-222222222222",
          kind: "route",
          href: `/media/${MEDIA_ID}`,
          unresolvedReason: null,
        },
        missing: false,
      },
    ],
    [
      "inferred legacy target",
      { kind: "Resource", href: `/media/${MEDIA_ID}` },
    ],
    [
      "extra target key",
      { kind: "External", href: "/browse/gutenberg/84", ref: "media:anything" },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeStandingActionTarget(value)).toThrow();
  });
});

describe("routeResourceActionSubject", () => {
  it("constructs one canonical route target for owned typed identities", () => {
    expect(
      routeResourceActionSubject({
        scheme: "media",
        id: MEDIA_ID,
        href: `/media/${MEDIA_ID}`,
      }),
    ).toEqual({
      kind: "Resource",
      ref: `media:${MEDIA_ID}`,
      activation: {
        resourceRef: `media:${MEDIA_ID}`,
        kind: "route",
        href: `/media/${MEDIA_ID}`,
        unresolvedReason: null,
      },
      missing: false,
    });
  });
});
