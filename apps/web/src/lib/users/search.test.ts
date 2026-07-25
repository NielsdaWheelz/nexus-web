import { describe, expect, it } from "vitest";
import {
  UserSearchContractDefect,
  expectUserSearchResults,
} from "./search";

const USER = "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB";

describe("user search contract", () => {
  it("preserves exact Presence projections", () => {
    expect(
      expectUserSearchResults({
        data: [
          {
            userHandle: USER,
            email: { kind: "Present", value: "reader@example.test" },
            displayName: { kind: "Absent" },
          },
        ],
      }),
    ).toEqual([
      {
        userHandle: USER,
        email: { kind: "Present", value: "reader@example.test" },
        displayName: { kind: "Absent" },
      },
    ]);
  });

  it.each([
    [
      "nullable absence",
      { userHandle: USER, email: null, displayName: { kind: "Absent" } },
    ],
    [
      "extra result key",
      {
        userHandle: USER,
        email: { kind: "Absent" },
        displayName: { kind: "Absent" },
        id: "private-id",
      },
    ],
    [
      "extra Presence key",
      {
        userHandle: USER,
        email: { kind: "Absent", value: "leak" },
        displayName: { kind: "Absent" },
      },
    ],
  ])("rejects %s", (_name, row) => {
    expect(() => expectUserSearchResults({ data: [row] })).toThrow(
      UserSearchContractDefect,
    );
  });
});
