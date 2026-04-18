import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const {
  mockIsLocalVaultSupported,
  mockLoadVaultDirectoryHandle,
  mockPickVaultDirectory,
  mockHasVaultPermission,
  mockSaveVaultDirectoryHandle,
  mockGetVaultAutoSync,
  mockSetVaultAutoSync,
  mockReadEditableVaultFiles,
  mockWriteVaultPayload,
  mockApiFetch,
} = vi.hoisted(() => ({
  mockIsLocalVaultSupported: vi.fn(),
  mockLoadVaultDirectoryHandle: vi.fn(),
  mockPickVaultDirectory: vi.fn(),
  mockHasVaultPermission: vi.fn(),
  mockSaveVaultDirectoryHandle: vi.fn(),
  mockGetVaultAutoSync: vi.fn(),
  mockSetVaultAutoSync: vi.fn(),
  mockReadEditableVaultFiles: vi.fn(),
  mockWriteVaultPayload: vi.fn(),
  mockApiFetch: vi.fn(),
}));

vi.mock("@/lib/vault/localVault", () => ({
  isLocalVaultSupported: () => mockIsLocalVaultSupported(),
  loadVaultDirectoryHandle: () => mockLoadVaultDirectoryHandle(),
  pickVaultDirectory: () => mockPickVaultDirectory(),
  hasVaultPermission: (...args: unknown[]) => mockHasVaultPermission(...args),
  saveVaultDirectoryHandle: (...args: unknown[]) => mockSaveVaultDirectoryHandle(...args),
  getVaultAutoSync: () => mockGetVaultAutoSync(),
  setVaultAutoSync: (...args: unknown[]) => mockSetVaultAutoSync(...args),
  readEditableVaultFiles: (...args: unknown[]) => mockReadEditableVaultFiles(...args),
  writeVaultPayload: (...args: unknown[]) => mockWriteVaultPayload(...args),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  isApiError: () => false,
}));

import SettingsLocalVaultPage from "./page";

describe("SettingsLocalVaultPage", () => {
  beforeEach(() => {
    mockIsLocalVaultSupported.mockReturnValue(true);
    mockLoadVaultDirectoryHandle.mockResolvedValue(null);
    mockPickVaultDirectory.mockResolvedValue({ name: "Vault" });
    mockHasVaultPermission.mockResolvedValue(true);
    mockSaveVaultDirectoryHandle.mockResolvedValue(undefined);
    mockGetVaultAutoSync.mockReturnValue(false);
    mockSetVaultAutoSync.mockReset();
    mockReadEditableVaultFiles.mockResolvedValue([]);
    mockWriteVaultPayload.mockResolvedValue(undefined);
    mockApiFetch.mockReset().mockResolvedValue({
      data: { files: [], delete_paths: [], conflicts: [] },
    });
  });

  it("connects a folder and exports the vault", async () => {
    const user = userEvent.setup();
    render(<SettingsLocalVaultPage />);

    expect(screen.queryByRole("heading", { name: "Local Vault" })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /connect folder/i }));
    expect(mockPickVaultDirectory).toHaveBeenCalledOnce();
    expect(mockSaveVaultDirectoryHandle).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /export vault/i }));
    expect(mockApiFetch).toHaveBeenCalledWith("/api/vault");
    expect(mockWriteVaultPayload).toHaveBeenCalledOnce();
  });

  it("stores the auto-sync preference", async () => {
    const user = userEvent.setup();
    render(<SettingsLocalVaultPage />);

    await user.click(await screen.findByRole("checkbox"));
    expect(mockSetVaultAutoSync).toHaveBeenCalledWith(true);
  });
});
