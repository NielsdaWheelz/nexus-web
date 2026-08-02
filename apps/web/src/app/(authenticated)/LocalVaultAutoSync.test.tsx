import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";

const {
  mockLoadVaultDirectoryHandle,
  mockReadEditableVaultFiles,
} = vi.hoisted(() => ({
  mockLoadVaultDirectoryHandle: vi.fn(),
  mockReadEditableVaultFiles: vi.fn(),
}));

vi.mock("@/lib/vault/localVault", () => ({
  getVaultAutoSync: () => true,
  hasVaultPermission: async () => true,
  isLocalVaultSupported: () => true,
  loadVaultDirectoryHandle: () => mockLoadVaultDirectoryHandle(),
  readEditableVaultFiles: (...args: unknown[]) =>
    mockReadEditableVaultFiles(...args),
  writeVaultPayload: vi.fn(),
}));

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return { ...actual, apiFetch: vi.fn() };
});

import LocalVaultAutoSync from "./LocalVaultAutoSync";

describe("LocalVaultAutoSync", () => {
  beforeEach(() => {
    mockLoadVaultDirectoryHandle.mockReset();
    mockReadEditableVaultFiles.mockReset();
  });

  it("keeps a persistent failure unresolved when a later sync has no folder", async () => {
    mockLoadVaultDirectoryHandle
      .mockResolvedValueOnce({ name: "Vault" })
      .mockResolvedValueOnce(null);
    mockReadEditableVaultFiles.mockRejectedValueOnce(
      new DOMException("folder unavailable", "NotReadableError"),
    );

    render(
      withRenderEnvironment(
        <FeedbackProvider>
          <LocalVaultAutoSync />
        </FeedbackProvider>,
      ),
    );

    expect(await screen.findByText("Local Vault refresh failed")).toBeVisible();

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() =>
      expect(mockLoadVaultDirectoryHandle).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByText("Local Vault refresh failed")).toBeVisible();
  });
});
