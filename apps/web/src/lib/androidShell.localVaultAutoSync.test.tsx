import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { ANDROID_SHELL_USER_AGENT_TOKEN } from "@/lib/androidShell";

const {
  getVaultAutoSyncMock,
  isLocalVaultSupportedMock,
  loadVaultDirectoryHandleMock,
  hasVaultPermissionMock,
  readEditableVaultFilesMock,
  writeVaultPayloadMock,
  apiFetchMock,
  toastMock,
} = vi.hoisted(() => ({
  getVaultAutoSyncMock: vi.fn(),
  isLocalVaultSupportedMock: vi.fn(),
  loadVaultDirectoryHandleMock: vi.fn(),
  hasVaultPermissionMock: vi.fn(),
  readEditableVaultFilesMock: vi.fn(),
  writeVaultPayloadMock: vi.fn(),
  apiFetchMock: vi.fn(),
  toastMock: vi.fn(),
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

vi.mock("@/components/Toast", () => ({
  useToast: () => ({ toast: toastMock }),
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
  });

  it("does not start local vault sync work in the android shell", () => {
    setUserAgent(`${DEFAULT_USER_AGENT} ${ANDROID_SHELL_USER_AGENT_TOKEN}`);
    isLocalVaultSupportedMock.mockReturnValue(true);
    getVaultAutoSyncMock.mockReturnValue(true);

    render(<LocalVaultAutoSync />);

    expect(loadVaultDirectoryHandleMock).not.toHaveBeenCalled();
    expect(apiFetchMock).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
