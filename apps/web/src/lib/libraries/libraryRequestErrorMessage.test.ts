import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { libraryRequestErrorMessage } from "./libraryRequestErrorMessage";

describe("libraryRequestErrorMessage", () => {
  it("guards product codes by their owning request and preserves diagnostics", () => {
    const limit = new ApiError(409, "E_LIMIT", "full", "req-limit");
    expect(
      libraryRequestErrorMessage(
        limit,
        { title: "Item wasn’t added", request: "LecternMutation" },
      ),
    ).toMatchObject({
      message: "Lectern is full. Remove an item, then try again.",
      requestId: "req-limit",
    });
    expect(() =>
      libraryRequestErrorMessage(
        limit,
        { title: "Library wasn’t created", request: "LibraryCreate" },
      ),
    ).toThrow(limit);

    const invite = new ApiError(
      409,
      "E_INVITE_ALREADY_EXISTS",
      "exists",
    );
    expect(
      libraryRequestErrorMessage(
        invite,
        { title: "Invitation failed", request: "InvitationMutation" },
      ),
    ).toMatchObject({ message: "This person already has a pending invitation." });
    expect(() =>
      libraryRequestErrorMessage(invite, {
        title: "Entries failed",
        request: "EntryRead",
      }),
    ).toThrow(invite);
  });

  it("rejects permission codes outside their owning request", () => {
    for (const code of [
      "E_OWNER_REQUIRED",
      "E_OWNER_EXIT_FORBIDDEN",
      "E_DEFAULT_LIBRARY_FORBIDDEN",
    ]) {
      const error = new ApiError(403, code, "forbidden");
      expect(() =>
        libraryRequestErrorMessage(error, {
          title: "Libraries failed",
          request: "LibraryCollectionRead",
        }),
      ).toThrow(error);
      expect(
        libraryRequestErrorMessage(error, {
          title: "Library change failed",
          request: "LibraryMutation",
        }),
      ).toMatchObject({ tone: "Danger" });
    }

    for (const code of ["E_LIBRARY_FORBIDDEN", "E_FORBIDDEN"]) {
      const scoped = new ApiError(403, code, "forbidden");
      for (const request of [
        "LibraryCollectionRead",
        "InvitationRead",
        "LibraryRead",
        "EntryRead",
      ] as const) {
        expect(() =>
          libraryRequestErrorMessage(scoped, {
            title: "Library read failed",
            request,
          }),
        ).toThrow(scoped);
      }
      expect(
        libraryRequestErrorMessage(scoped, {
          title: "Library change failed",
          request: "LibraryMutation",
        }),
      ).toMatchObject({ tone: "Danger" });

      if (code === "E_LIBRARY_FORBIDDEN") {
        for (const request of ["LibraryCreate", "LecternMutation"] as const) {
          expect(() =>
            libraryRequestErrorMessage(scoped, {
              title: "Unrelated mutation failed",
              request,
            }),
          ).toThrow(scoped);
        }
        expect(
          libraryRequestErrorMessage(scoped, {
            title: "Entry change failed",
            request: "EntryMutation",
          }),
        ).toMatchObject({ tone: "Danger" });
      }
    }
  });
});
