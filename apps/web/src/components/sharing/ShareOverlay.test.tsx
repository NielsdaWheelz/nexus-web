import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ShareOverlay from "./ShareOverlay";
import { createLinkShare, fetchShareSnapshot } from "@/lib/sharing/api";
import {
  assumeCanonicalResourceRef,
  resourceShareTarget,
} from "@/lib/sharing/targets";

vi.mock("@/lib/sharing/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sharing/api")>(
    "@/lib/sharing/api",
  );
  return {
    ...actual,
    createLinkShare: vi.fn(),
    fetchShareSnapshot: vi.fn(),
  };
});
vi.mock("@/lib/ui/useIsMobileViewport", () => ({
  useIsMobileViewport: () => false,
}));
vi.mock("@/lib/media/useLibraryMembership", () => ({
  useLibraryMembership: () => ({
    libraries: [],
    loading: false,
    error: null,
    setMembership: vi.fn(),
  }),
}));

const fetchShareSnapshotMock = vi.mocked(fetchShareSnapshot);
const createLinkShareMock = vi.mocked(createLinkShare);
const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
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
        handle:
          "nrg1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
        publicHref: PUBLIC_HREF,
      },
    ],
    receivedAccess: [],
  };
}

function setNativeShare(share: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: share,
  });
}

describe("ShareOverlay public native sharing", () => {
  beforeEach(() => {
    fetchShareSnapshotMock.mockResolvedValue(snapshot());
    createLinkShareMock.mockReset();
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
    await user.click(
      screen.getByRole("button", { name: "Share public link" }),
    );
    expect(share).not.toHaveBeenCalled();
    expect(
      screen.getByText(/destination gains read access and may retain the credential/i),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Continue to share" }),
    );
    expect(share).toHaveBeenCalledWith({
      title: "Shared from Nexus",
      url: PUBLIC_HREF,
    });
    expect(
      screen.queryByText(/destination gains read access and may retain the credential/i),
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
    await user.click(
      screen.getByRole("button", { name: "Continue to share" }),
    );
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
    await user.click(
      screen.getByRole("button", { name: "Continue to share" }),
    );
    expect(
      await screen.findByText("The share menu could not be opened."),
    ).toHaveAttribute("role", "alert");
    expect(
      screen.getByRole("button", { name: "Continue to share" }),
    ).toBeInTheDocument();
  });

  it("discloses X bearer access before leaving Nexus", async () => {
    const user = userEvent.setup();
    const open = vi
      .spyOn(window, "open")
      .mockReturnValue({} as Window);
    render(<ShareOverlay session={session()} onClose={vi.fn()} />);

    await user.click(
      await screen.findByRole("button", { name: "Post to X" }),
    );
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

    await user.click(
      await screen.findByRole("button", { name: "Post to X" }),
    );
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
});
