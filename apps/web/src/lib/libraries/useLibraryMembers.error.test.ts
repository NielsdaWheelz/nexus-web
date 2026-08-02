import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { libraryGovernanceErrorMessage } from "./useLibraryMembers";

describe("libraryGovernanceErrorMessage", () => {
  it("maps only structured expected API failures", () => {
    expect(
      libraryGovernanceErrorMessage(
        new ApiError(0, "E_NETWORK", "offline"),
        "Could not update members.",
      ),
    ).toMatchObject({ tone: "Danger" });
    expect(
      libraryGovernanceErrorMessage(
        new ApiError(409, "E_INVITE_MEMBER_EXISTS", "member exists"),
        "Could not update members.",
      ),
    ).toMatchObject({ message: "This person is already a library member." });
  });

  it("rethrows same-system, unknown-code, and unexpected defects", () => {
    expect(
      () => libraryGovernanceErrorMessage(
        new ApiError(500, "E_INVALID_RESPONSE", "malformed"),
        "Could not update members.",
      ),
    ).toThrow("malformed");
    expect(
      () => libraryGovernanceErrorMessage(
        new ApiError(409, "E_NEW_GOVERNANCE_FAILURE", "new code"),
        "Could not update members.",
      ),
    ).toThrow("new code");
    expect(
      () => libraryGovernanceErrorMessage(
        new Error("unexpected"),
        "Could not update members.",
      ),
    ).toThrow("unexpected");
  });
});
