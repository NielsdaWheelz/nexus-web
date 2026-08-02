import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api/client";
import { localVaultErrorMessage } from "./localVaultErrorMessage";

describe("localVaultErrorMessage", () => {
  it("maps the finite endpoint channel with operation-specific copy", () => {
    const network = localVaultErrorMessage(
      new ApiError(0, "E_NETWORK", "offline", "req-vault"),
      "ExportVault",
    );
    expect(network).toMatchObject({
      tone: "Danger",
      title: "Vault wasn’t written",
      requestId: "req-vault",
    });

    const conflict = localVaultErrorMessage(
      new ApiError(409, "E_HIGHLIGHT_CONFLICT", "changed"),
      "SyncVault",
    );
    expect(conflict?.message).toContain("conflict file");
  });

  it("treats picker cancellation as ordinary and maps permission recovery", () => {
    expect(
      localVaultErrorMessage(
        new DOMException("cancelled", "AbortError"),
        "ConnectFolder",
      ),
    ).toBeNull();
    expect(
      localVaultErrorMessage(
        new DOMException("denied", "NotAllowedError"),
        "ConnectFolder",
      )?.message,
    ).toContain("Reconnect");
  });

  it("rethrows defects, unknown endpoint codes, and unknown browser errors", () => {
    for (const error of [
      new ApiError(500, "E_INTERNAL", "defect"),
      new ApiError(418, "E_NEW_VAULT_CODE", "unknown"),
      new DOMException("unknown", "OperationError"),
      new Error("unexpected"),
    ]) {
      expect(() => localVaultErrorMessage(error, "SyncVault")).toThrow(error);
    }
  });
});
