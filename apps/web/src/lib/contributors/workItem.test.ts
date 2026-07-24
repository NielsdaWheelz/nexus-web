import { describe, expect, it } from "vitest";
import { decodeContributorWorkItem } from "./workItem";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";

function wire(overrides: Record<string, unknown> = {}) {
  return {
    title: "A Wizard of Earthsea",
    href: `/media/${MEDIA_ID}`,
    contentKind: "epub",
    date: "1968",
    roleFacts: [
      { creditedName: "Ursula K. Le Guin", role: "author", rawRole: null },
    ],
    actionTarget: {
      kind: "Resource",
      ref: `media:${MEDIA_ID}`,
      activation: {
        resourceRef: `media:${MEDIA_ID}`,
        kind: "route",
        href: `/media/${MEDIA_ID}`,
        unresolvedReason: null,
      },
      missing: false,
    },
    ...overrides,
  };
}

function withoutDate() {
  const { date: _date, ...value } = wire();
  return value;
}

function withoutRoleFacts() {
  const { roleFacts: _roleFacts, ...value } = wire();
  return value;
}

describe("decodeContributorWorkItem", () => {
  it("decodes the exact camelCase contract and Presence date", () => {
    expect(decodeContributorWorkItem(wire())).toEqual({
      title: "A Wizard of Earthsea",
      href: `/media/${MEDIA_ID}`,
      contentKind: "epub",
      date: { kind: "Present", value: "1968" },
      roleFacts: [
        { creditedName: "Ursula K. Le Guin", role: "author", rawRole: null },
      ],
      actionTarget: {
        kind: "Resource",
        ref: `media:${MEDIA_ID}`,
        activation: {
          resourceRef: `media:${MEDIA_ID}`,
          kind: "route",
          href: `/media/${MEDIA_ID}`,
          unresolvedReason: null,
        },
        missing: false,
      },
    });
    expect(decodeContributorWorkItem(wire({ date: null })).date).toEqual({
      kind: "Absent",
    });
  });

  it.each([
    ["missing date", withoutDate()],
    ["missing roleFacts", withoutRoleFacts()],
    [
      "missing actionTarget",
      (({ actionTarget: _actionTarget, ...value }) => value)(wire()),
    ],
    ["extra key", { ...wire(), legacyDate: "1968" }],
    ["non-array roleFacts", wire({ roleFacts: null })],
    [
      "missing rawRole",
      wire({ roleFacts: [{ creditedName: "Ursula", role: "author" }] }),
    ],
    ["invalid rawRole", wire({ roleFacts: [{ creditedName: "Ursula", role: "author", rawRole: 1 }] })],
    ["unreal date", wire({ date: "2025-02-29" })],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeContributorWorkItem(value)).toThrow();
  });
});
