import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

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
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly requestId?: string;

    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
    }
  },
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
  isApiError: () => false,
}));

import SettingsLocalVaultPaneBody from "./SettingsLocalVaultPaneBody";

describe("SettingsLocalVaultPaneBody", () => {
  beforeEach(() => {
    mockIsLocalVaultSupported.mockReturnValue(true);
    mockLoadVaultDirectoryHandle.mockReset();
    mockLoadVaultDirectoryHandle.mockResolvedValue(null);
    mockPickVaultDirectory.mockReset();
    mockPickVaultDirectory.mockResolvedValue({ name: "Vault" });
    mockHasVaultPermission.mockReset();
    mockHasVaultPermission.mockResolvedValue(true);
    mockSaveVaultDirectoryHandle.mockReset();
    mockSaveVaultDirectoryHandle.mockResolvedValue(undefined);
    mockGetVaultAutoSync.mockReturnValue(false);
    mockSetVaultAutoSync.mockReset();
    mockReadEditableVaultFiles.mockReset();
    mockReadEditableVaultFiles.mockResolvedValue([]);
    mockWriteVaultPayload.mockReset();
    mockWriteVaultPayload.mockResolvedValue(undefined);
    mockApiFetch.mockReset().mockResolvedValue({
      data: { files: [], delete_paths: [], conflicts: [] },
    });
  });

  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
  });

  it("connects a folder and exports the vault", async () => {
    const user = userEvent.setup();
    render(<SettingsLocalVaultPaneBody />);

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
    render(<SettingsLocalVaultPaneBody />);

    await user.click(await screen.findByRole("checkbox"));
    expect(mockSetVaultAutoSync).toHaveBeenCalledWith(true);
  });

  it("shows an unsupported message and skips local vault APIs in the android shell", () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);

    render(<SettingsLocalVaultPaneBody />);

    expect(
      screen.getByText(
        "Local Vault is not available in the Android app. Use a supported desktop browser to connect and sync a local folder."
      )
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /connect folder/i })).not.toBeInTheDocument();
    expect(mockLoadVaultDirectoryHandle).not.toHaveBeenCalled();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });
});
