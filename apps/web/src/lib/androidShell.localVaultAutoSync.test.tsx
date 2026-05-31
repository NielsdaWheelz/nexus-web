import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const {
  getVaultAutoSyncMock,
  isLocalVaultSupportedMock,
  loadVaultDirectoryHandleMock,
  hasVaultPermissionMock,
  readEditableVaultFilesMock,
  writeVaultPayloadMock,
  apiFetchMock,
} = vi.hoisted(() => ({
  getVaultAutoSyncMock: vi.fn(),
  isLocalVaultSupportedMock: vi.fn(),
  loadVaultDirectoryHandleMock: vi.fn(),
  hasVaultPermissionMock: vi.fn(),
  readEditableVaultFilesMock: vi.fn(),
  writeVaultPayloadMock: vi.fn(),
  apiFetchMock: vi.fn(),
}));

vi.mock("@/lib/vault/localVault", () => ({
  getVaultAutoSync: () => getVaultAutoSyncMock(),
  hasVaultPermission: (...args: unknown[]) => hasVaultPermissionMock(...args),
  isLocalVaultSupported: () => isLocalVaultSupportedMock(),
  loadVaultDirectoryHandle: () => loadVaultDirectoryHandleMock(),
  readEditableVaultFiles: (...args: unknown[]) => readEditableVaultFilesMock(...args),
  writeVaultPayload: (...args: unknown[]) => writeVaultPayloadMock(...args),
}));

vi.mock("@/lib/api/client", () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  isApiError: () => false,
}));

import LocalVaultAutoSync from "@/app/(authenticated)/LocalVaultAutoSync";

const DEFAULT_USER_AGENT = navigator.userAgent;

function setUserAgent(userAgent: string) {
  Object.defineProperty(window.navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
}

describe("LocalVaultAutoSync android shell gating", () => {
  afterEach(() => {
    setUserAgent(DEFAULT_USER_AGENT);
    vi.clearAllMocks();
  });

  it("does not start local vault sync work in the android shell", () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);
    isLocalVaultSupportedMock.mockReturnValue(true);
    getVaultAutoSyncMock.mockReturnValue(true);

    render(
      <FeedbackProvider>
        <LocalVaultAutoSync />
      </FeedbackProvider>
    );

    expect(loadVaultDirectoryHandleMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("runs only one local vault sync across concurrent mounts", async () => {
    const handle = {} as FileSystemDirectoryHandle;
    let resolveHandle: (handle: FileSystemDirectoryHandle) => void = () => {};
    setUserAgent(DEFAULT_USER_AGENT);
    isLocalVaultSupportedMock.mockReturnValue(true);
    getVaultAutoSyncMock.mockReturnValue(true);
    loadVaultDirectoryHandleMock.mockReturnValue(
      new Promise<FileSystemDirectoryHandle>((resolve) => {
        resolveHandle = resolve;
      })
    );
    hasVaultPermissionMock.mockResolvedValue(true);
    readEditableVaultFilesMock.mockResolvedValue([{ path: "Pages/a.md", content: "A" }]);
    apiFetchMock.mockResolvedValue({ data: { files: [], delete_paths: [], conflicts: [] } });
    writeVaultPayloadMock.mockResolvedValue(undefined);

    render(
      <FeedbackProvider>
        <LocalVaultAutoSync />
        <LocalVaultAutoSync />
      </FeedbackProvider>
    );

    expect(loadVaultDirectoryHandleMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveHandle(handle);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(writeVaultPayloadMock).toHaveBeenCalledTimes(1);
    });
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops at an awaited boundary after unmount", async () => {
    const handle = {} as FileSystemDirectoryHandle;
    let resolveHandle: (handle: FileSystemDirectoryHandle) => void = () => {};
    setUserAgent(DEFAULT_USER_AGENT);
    isLocalVaultSupportedMock.mockReturnValue(true);
    getVaultAutoSyncMock.mockReturnValue(true);
    loadVaultDirectoryHandleMock.mockReturnValue(
      new Promise<FileSystemDirectoryHandle>((resolve) => {
        resolveHandle = resolve;
      })
    );

    const { unmount } = render(
      <FeedbackProvider>
        <LocalVaultAutoSync />
      </FeedbackProvider>
    );

    expect(loadVaultDirectoryHandleMock).toHaveBeenCalledTimes(1);
    unmount();

    await act(async () => {
      resolveHandle(handle);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(hasVaultPermissionMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(writeVaultPayloadMock).not.toHaveBeenCalled();
  });
});
