import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { absent } from "@/lib/api/presence";
import type { BrowsePage } from "@/lib/browse/contract";
import BrowseSection, { type BrowseSectionIdentity } from "./BrowseSection";

const mocks = vi.hoisted(() => ({
  fetchBrowsePage: vi.fn(),
}));

vi.mock("@/lib/browse/client", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/browse/client")>();
  return {
    ...original,
    fetchBrowsePage: mocks.fetchBrowsePage,
  };
});

vi.mock("@/components/collections/CollectionView", () => ({
  default: () => null,
}));

vi.mock("@/components/ui/PaneSection", () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const identity: BrowseSectionIdentity = {
  kind: "WebArticle",
  source: "Brave",
  sort: "Relevance",
};

const restored: BrowsePage = {
  query: "nexus",
  kind: "WebArticle",
  source: "Brave",
  sort: absent(),
  items: [],
  nextCursor: absent(),
};

describe("BrowseSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("settles a restored ready section without refetching or repeating snapshots", async () => {
    const onController = vi.fn();
    const props = {
      label: "Web Article · Brave",
      query: "nexus",
      identity,
      restored: { kind: "Ready" as const, page: restored },
      onController,
      runRequest: <T,>(_signal: AbortSignal, request: () => Promise<T>) =>
        request(),
    };

    const view = render(<BrowseSection {...props} />);

    await waitFor(() => expect(onController).toHaveBeenCalledTimes(1));
    view.rerender(<BrowseSection {...props} />);
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    expect(onController).toHaveBeenCalledTimes(1);
    expect(mocks.fetchBrowsePage).not.toHaveBeenCalled();
    expect(onController).toHaveBeenLastCalledWith(identity, {
      kind: "Ready",
      page: restored,
    });
  });

  it.each([
    {
      label: "interrupted pending request as retriable",
      restored: { kind: "Pending" as const, page: null },
      expectedStatus: "Search paused",
    },
    {
      label: "first-page failure",
      restored: {
        kind: "Failed" as const,
        page: null,
        failure: {
          status: 0,
          code: "E_NETWORK",
          message: "offline",
          requestId: null,
          details: null,
        },
      },
      expectedStatus: "Connection lost",
    },
    {
      label: "continuation failure",
      restored: {
        kind: "Failed" as const,
        page: {
          ...restored,
          nextCursor: { kind: "Present" as const, value: "next-page" },
        },
        failure: {
          status: 0,
          code: "E_NETWORK",
          message: "offline",
          requestId: null,
          details: null,
        },
      },
      expectedStatus: "Connection lost",
    },
  ])("restores $label exactly without refetching", async ({
    restored: restoredController,
    expectedStatus,
  }) => {
    const onController = vi.fn();

    render(
      <BrowseSection
        label="Web Article · Brave"
        query="nexus"
        identity={identity}
        restored={restoredController}
        onController={onController}
        runRequest={async <T,>(
          _signal: AbortSignal,
          request: () => Promise<T>,
        ) => request()}
      />,
    );

    expect(await screen.findByText(expectedStatus)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(mocks.fetchBrowsePage).not.toHaveBeenCalled();
  });
});
