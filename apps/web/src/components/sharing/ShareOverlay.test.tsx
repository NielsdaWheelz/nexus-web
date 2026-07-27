import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareOverlay from "./ShareOverlay";
import { getMemberLibrary } from "@/lib/libraries/client";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import { ApiError } from "@/lib/api/client";
import { LibraryContractDefect } from "@/lib/libraries/contract";
import { createLinkShare, fetchShareSnapshot } from "@/lib/sharing/api";
import {
  assumeCanonicalResourceRef,
  resourceShareTarget,
} from "@/lib/sharing/targets";

vi.mock("@/lib/sharing/api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/sharing/api")>(
      "@/lib/sharing/api",
    );
  return {
    ...actual,
    createLinkShare: vi.fn(),
    fetchShareSnapshot: vi.fn(),
  };
});
vi.mock("@/lib/libraries/client", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/libraries/client")>(
      "@/lib/libraries/client",
    );
  return {
    ...actual,
    getMemberLibrary: vi.fn(),
  };
});
vi.mock("@/lib/workspace/workspaceTargetActivationIngress", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/workspace/workspaceTargetActivationIngress")>(
      "@/lib/workspace/workspaceTargetActivationIngress",
    );
  return {
    ...actual,
    requestWorkspaceTargetActivation: vi.fn(),
  };
});
vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));

const fetchShareSnapshotMock = vi.mocked(fetchShareSnapshot);
const createLinkShareMock = vi.mocked(createLinkShare);
const getMemberLibraryMock = vi.mocked(getMemberLibrary);
const requestWorkspaceTargetActivationMock = vi.mocked(requestWorkspaceTargetActivation);
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const LIBRARY_ID = "22222222-2222-4222-8222-222222222222";
const PUBLIC_HREF = `http://localhost:3000/s#share=nxshr1_${"A".repeat(43)}`;

function session() {
  return {
    key: 1,
    target: resourceShareTarget(`highlight:${MEDIA_ID}`),
    options: {
      returnFocusTo: () => null,
      returnFocusFallback: { kind: "Absent" as const },
    },
  };
}

function snapshot() {
  return {
    subject: assumeCanonicalResourceRef(`highlight:${MEDIA_ID}`),
    sharing: "HighlightGrants" as const,
    authenticatedHref: `http://localhost:3000/media/${MEDIA_ID}#highlight-${MEDIA_ID}`,
    creationAvailability: {
      user: { kind: "Available" as const },
      link: { kind: "Available" as const },
    },
    shares: [
      {
        kind: "Link" as const,
        handle: "nrg1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        publicHref: PUBLIC_HREF,
      },
    ],
    receivedAccess: [],
  };
}

function librarySession() {
  return {
    key: 2,
    target: resourceShareTarget(`library:${LIBRARY_ID}`),
    options: {
      returnFocusTo: () => null,
      returnFocusFallback: { kind: "Absent" as const },
    },
  };
}

function librarySnapshot() {
  return {
    subject: assumeCanonicalResourceRef(`library:${LIBRARY_ID}`),
    sharing: "LibraryMembership" as const,
    authenticatedHref: `http://localhost:3000/libraries/${LIBRARY_ID}`,
    creationAvailability: {
      user: {
        kind: "Unavailable" as const,
        reason: "UnsupportedSubject" as const,
      },
      link: {
        kind: "Unavailable" as const,
        reason: "UnsupportedSubject" as const,
      },
    },
    shares: [],
    receivedAccess: [],
  };
}

function libraryOut(
  overrides: Partial<Awaited<ReturnType<typeof getMemberLibrary>>> = {},
) {
  return {
    id: LIBRARY_ID,
    name: "Research",
    color: null,
    ownerUserHandle:
      "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
    isDefault: false,
    role: "admin" as const,
    systemKey: null,
    canRename: true,
    canDelete: true,
    canEditEntries: true,
    canManageMembers: true,
    canTransferOwnership: true,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function setNativeShare(share: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: share,
  });
}

class TestErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    return this.state.error ? (
      <div role="alert">{this.state.error.message}</div>
    ) : (
      this.props.children
    );
  }
}

function renderWithBoundary(children: ReactNode) {
  return render(<TestErrorBoundary>{children}</TestErrorBoundary>);
}

describe("ShareOverlay public native sharing", () => {
  beforeEach(() => {
    fetchShareSnapshotMock.mockResolvedValue(snapshot());
    createLinkShareMock.mockReset();
    getMemberLibraryMock.mockReset();
    requestWorkspaceTargetActivationMock.mockReset();
  });

  it("opens the canonical Library pane on Members and closes after accepted dispatch", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchShareSnapshotMock.mockResolvedValue(librarySnapshot());
    getMemberLibraryMock.mockResolvedValue(libraryOut());
    requestWorkspaceTargetActivationMock.mockReturnValue(true);

    render(<ShareOverlay session={librarySession()} onClose={onClose} />);
    await user.click(
      await screen.findByRole("button", { name: "Manage members" }),
    );

    expect(requestWorkspaceTargetActivationMock).toHaveBeenCalledWith({
      target: {
        href: librarySnapshot().authenticatedHref,
        secondaryActivation: {
          kind: "Surface",
          surfaceId: "resource-members",
        },
      },
      disposition: { kind: "Follow" },
      modality: "Programmatic",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps Share open and reports a rejected Members dispatch", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    fetchShareSnapshotMock.mockResolvedValue(librarySnapshot());
    getMemberLibraryMock.mockResolvedValue(libraryOut());
    requestWorkspaceTargetActivationMock.mockReturnValue(false);

    render(<ShareOverlay session={librarySession()} onClose={onClose} />);
    await user.click(
      await screen.findByRole("button", { name: "Manage members" }),
    );

    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText("Members could not be opened. Try again."),
    ).toHaveAttribute("role", "alert");
  });

  it("omits member-management UI for default or system Libraries", async () => {
    fetchShareSnapshotMock.mockResolvedValue(librarySnapshot());
    getMemberLibraryMock.mockResolvedValue(
      libraryOut({ isDefault: true, canManageMembers: false }),
    );

    render(<ShareOverlay session={librarySession()} onClose={vi.fn()} />);

    await screen.findByRole("button", { name: "Copy link" });
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "People" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.queryByText(/managed by library admins/i),
    ).not.toBeInTheDocument();
  });

  it("routes a non-Library LibraryMembership subject to the render boundary", async () => {
    fetchShareSnapshotMock.mockResolvedValue({
      ...librarySnapshot(),
      subject: assumeCanonicalResourceRef(`media:${MEDIA_ID}`),
    });

    renderWithBoundary(
      <ShareOverlay session={librarySession()} onClose={vi.fn()} />,
    );

    expect(
      await screen.findByText(
        "Library sharing received a non-library subject",
      ),
    ).toHaveAttribute("role", "alert");
  });

  it("routes a mismatched capability projection defect to the render boundary", async () => {
    fetchShareSnapshotMock.mockResolvedValue(librarySnapshot());
    getMemberLibraryMock.mockRejectedValue(
      new LibraryContractDefect(
        "get Library response.data.id does not match requested Library",
      ),
    );

    renderWithBoundary(
      <ShareOverlay session={librarySession()} onClose={vi.fn()} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "does not match requested Library",
    );
  });

  it("routes an invalid capability response to the render boundary", async () => {
    fetchShareSnapshotMock.mockResolvedValue(librarySnapshot());
    getMemberLibraryMock.mockRejectedValue(
      new ApiError(
        500,
        "E_INVALID_RESPONSE",
        "Library capability response was malformed",
      ),
    );

    renderWithBoundary(
      <ShareOverlay session={librarySession()} onClose={vi.fn()} />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Library capability response was malformed",
    );
  });

  it("keeps canonical link actions available when capability loading fails", async () => {
    fetchShareSnapshotMock.mockResolvedValue(librarySnapshot());
    getMemberLibraryMock.mockRejectedValue(new TypeError("offline"));

    render(<ShareOverlay session={librarySession()} onClose={vi.fn()} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Member-management access could not be checked.",
    );
    expect(screen.getByRole("button", { name: "Copy link" })).toBeEnabled();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, "share");
  });

  it("requires bearer-retention disclosure before invoking native Share", async () => {
    const user = userEvent.setup();
    const share = vi.fn().mockResolvedValue(undefined);
    setNativeShare(share);
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);

    expect(
      await screen.findByText(
        /this person can read and reshare the media\. they may already have access another way\./i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        /this share also includes this exact highlight and its source media/i,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Share public link" }));
    expect(share).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /destination gains read access and may retain the credential/i,
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue to share" }));
    expect(share).toHaveBeenCalledWith({
      title: "Shared from Nexus",
      url: PUBLIC_HREF,
    });
    expect(
      screen.queryByText(
        /destination gains read access and may retain the credential/i,
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps AbortError silent", async () => {
    const user = userEvent.setup();
    setNativeShare(
      vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")),
    );
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "Share public link" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue to share" }));
    expect(
      screen.queryByText("The share menu could not be opened."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue to share" }),
    ).toBeInTheDocument();
  });

  it("shows a retryable hard failure", async () => {
    const user = userEvent.setup();
    setNativeShare(vi.fn().mockRejectedValue(new Error("OS share failed")));
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);
    await user.click(
      await screen.findByRole("button", { name: "Share public link" }),
    );
    await user.click(screen.getByRole("button", { name: "Continue to share" }));
    expect(
      await screen.findByText("The share menu could not be opened."),
    ).toHaveAttribute("role", "alert");
    expect(
      screen.getByRole("button", { name: "Continue to share" }),
    ).toBeInTheDocument();
  });

  it("discloses X bearer access before leaving Nexus", async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Post to X" }));
    expect(open).not.toHaveBeenCalled();
    expect(
      screen.getByText(/x gains read access and may retain the credential/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Continue to X" }));
    expect(open).toHaveBeenCalledWith(
      `https://x.com/intent/post?url=${encodeURIComponent(PUBLIC_HREF)}`,
      "_blank",
      "noopener,noreferrer",
    );
  });

  it("keeps the X confirmation retryable when the popup is blocked", async () => {
    const user = userEvent.setup();
    vi.spyOn(window, "open").mockReturnValue(null);
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Post to X" }));
    await user.click(screen.getByRole("button", { name: "Continue to X" }));

    expect(
      await screen.findByText(
        "X could not be opened. Check your popup settings and try again.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(
      screen.getByRole("button", { name: "Continue to X" }),
    ).toBeInTheDocument();
  });

  it("reconciles an idempotently returned public link into stale UI state", async () => {
    const user = userEvent.setup();
    const value = snapshot();
    const link = value.shares[0];
    fetchShareSnapshotMock.mockResolvedValueOnce({ ...value, shares: [] });
    createLinkShareMock.mockResolvedValueOnce({
      created: false,
      share: link,
    });
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", { name: "Turn on public link" }),
    );

    expect(
      await screen.findByRole("button", { name: "Copy public link" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Your public link was already on."),
    ).toHaveAttribute("role", "status");
  });

  it("keeps podcast Share copy-only and contains no library placement UI", async () => {
    const podcastRef = assumeCanonicalResourceRef(`podcast:${MEDIA_ID}`);
    fetchShareSnapshotMock.mockResolvedValueOnce({
      subject: podcastRef,
      sharing: "CopyOnly",
      authenticatedHref: `http://localhost:3000/podcasts/${MEDIA_ID}`,
      creationAvailability: {
        user: { kind: "Unavailable", reason: "UnsupportedSubject" },
        link: { kind: "Unavailable", reason: "UnsupportedSubject" },
      },
      shares: [],
      receivedAccess: [],
    });

    render(
      <ShareOverlay
        session={{
          ...session(),
          target: resourceShareTarget(podcastRef),
        }}
        onClose={vi.fn()}
      />,
    );

    expect(
      await screen.findByText(
        "This link does not change who can open the item.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Libraries" }),
    ).not.toBeInTheDocument();
  });
});
