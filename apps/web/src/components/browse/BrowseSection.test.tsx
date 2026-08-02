import "@/app/globals.css";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import { jsonResponse, stubFetch } from "@/__tests__/helpers/fetch";
import { absent, present } from "@/lib/api/presence";
import type { BrowsePage } from "@/lib/browse/contract";
import type { BrowseSectionIdentity } from "@/lib/browse/plan";
import type { BrowseRequestRunner } from "@/lib/browse/requestGate";
import BrowseSection, {
  type BrowseSectionSnapshot,
} from "./BrowseSection";

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

const runRequest: BrowseRequestRunner = async (_signal, request) => request();

function candidateWire(title: string, href: string) {
  return {
    kind: "WebArticle",
    source: "Brave",
    resolution: { kind: "InNexus", href },
    title,
    contributors: [],
    description: absent(),
    publishedAt: absent(),
    image: absent(),
    kindFacts: { siteName: absent() },
  };
}

function pageResponse(
  items: readonly ReturnType<typeof candidateWire>[],
  nextCursor: string | null,
) {
  return jsonResponse({
    data: {
      query: "nexus",
      kind: "WebArticle",
      source: "Brave",
      sort: absent(),
      items,
      nextCursor: nextCursor === null ? absent() : present(nextCursor),
    },
  });
}

function renderSection({
  restored: restoredSnapshot,
  onController = vi.fn(),
}: {
  restored: BrowseSectionSnapshot | null;
  onController?: (
    section: BrowseSectionIdentity,
    snapshot: BrowseSectionSnapshot,
  ) => void;
}) {
  return {
    onController,
    ...renderHydratedPane({
      href: "/browse?q=nexus",
      resources: {},
      children: (
        <BrowseSection
          label="Brave"
          query="nexus"
          identity={identity}
          restored={restoredSnapshot}
          onController={onController}
          runRequest={runRequest}
        />
      ),
    }),
  };
}

describe("BrowseSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a restored source as a quiet named region without refetching", async () => {
    const fetchMock = stubFetch();
    const { onController } = renderSection({
      restored: { kind: "Ready", page: restored },
    });

    const source = screen.getByRole("region", { name: "Brave" });
    expect(
      screen.getByRole("heading", { level: 3, name: "Brave" }),
    ).toBeInTheDocument();
    expect(source).toHaveTextContent("No results");
    await waitFor(() => expect(onController).toHaveBeenCalledTimes(1));
    expect(onController).toHaveBeenLastCalledWith(identity, {
      kind: "Ready",
      page: restored,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps an interrupted restore local until its source Retry is explicit", async () => {
    const fetchMock = stubFetch(async () => pageResponse([], null));
    const { onController } = renderSection({
      restored: { kind: "Pending", page: null },
    });

    expect(screen.getByText("Search paused")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Retry Brave" }));

    expect(await screen.findByText("No results")).toBeInTheDocument();
    await waitFor(() =>
      expect(onController).toHaveBeenLastCalledWith(identity, {
        kind: "Ready",
        page: restored,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("appends continuation results in place without replacing surfaced rows", async () => {
    const fetchMock = stubFetch(async (input) => {
      const url = new URL(String(input), "http://localhost");
      return url.searchParams.has("cursor")
        ? pageResponse([candidateWire("Second result", "/media/second")], null)
        : pageResponse(
            [candidateWire("First result", "/media/first")],
            "next-page",
          );
    });
    const { onController } = renderSection({ restored: null });

    expect(
      await screen.findByRole("link", { name: "First result" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByRole("link", { name: "Second result" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("link").map((link) => link.textContent),
    ).toEqual(["First result", "Second result"]);
    await waitFor(() =>
      expect(onController).toHaveBeenLastCalledWith(
        identity,
        expect.objectContaining({
          kind: "Ready",
          page: expect.objectContaining({
            items: expect.arrayContaining([
              expect.objectContaining({ title: "First result" }),
              expect.objectContaining({ title: "Second result" }),
            ]),
          }),
        }),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
