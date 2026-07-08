import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  fetchInputPath,
  jsonResponse,
  stubFetch,
  wasFetchPathCalled,
} from "@/__tests__/helpers/fetch";
import NotePaneBody from "./NotePaneBody";

describe("NotePaneBody resource identity", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the note body directly without resolving a parent page", async () => {
    const blockId = "55555555-5555-4555-8555-555555555555";
    const fetchSpy = stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (path === `/api/notes/blocks/${blockId}`) {
        return jsonResponse({
          data: {
            id: blockId,
            bodyPmJson: {
              type: "paragraph",
              content: [{ type: "text", text: "Standalone note" }],
            },
            bodyText: "Standalone note",
            collapsed: false,
            children: [],
            versionByLane: { body: 3, outgoing_edges: 1 },
          },
        });
      }
      return new Promise<Response>(() => {});
    });

    renderHydratedPane({
      href: `/notes/${blockId}`,
      resources: {},
      children: <NotePaneBody />,
    });

    await waitFor(() => {
      expect(wasFetchPathCalled(fetchSpy, `/api/notes/blocks/${blockId}`)).toBe(true);
    });
    await screen.findByRole("textbox", { name: "Note body" });
    expect(fetchSpy.mock.calls.some(([input]) => fetchInputPath(input).startsWith("/api/notes/pages/"))).toBe(false);
  });
});

describe("NotePaneBody connections footer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("mounts the connections apparatus inline in the note footer", async () => {
    const blockId = "66666666-6666-4666-8666-666666666666";
    // Only the network boundary is mocked: the note body loads, and the
    // connections apparatus answers its resource-graph + synapse probes empty.
    stubFetch(async (input) => {
      const path = fetchInputPath(input);
      if (path === `/api/notes/blocks/${blockId}`) {
        return jsonResponse({
          data: {
            id: blockId,
            bodyPmJson: {
              type: "paragraph",
              content: [{ type: "text", text: "Footnoted note" }],
            },
            bodyText: "Footnoted note",
            collapsed: false,
            children: [],
            versionByLane: { body: 1, outgoing_edges: 1 },
          },
        });
      }
      if (path === "/api/resource-graph/connections/query") {
        return jsonResponse({ data: { items: [], next_cursor: null } });
      }
      if (path.startsWith("/api/synapse/scans")) {
        return jsonResponse({ data: { status: "idle" } });
      }
      return jsonResponse({ data: [] });
    });

    renderHydratedPane({
      href: `/notes/${blockId}`,
      resources: {},
      children: <NotePaneBody />,
    });

    // The connections apparatus renders in place (no secondary drawer); its
    // composer is quiet by default, collapsed behind the "＋ Connect" disclosure.
    expect(
      await screen.findByRole("region", { name: "Connections" }),
    ).toBeInTheDocument();
    const disclosure = screen.getByRole("button", { name: /Connect/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("textbox", { name: "Connection target" }),
    ).not.toBeInTheDocument();
  });
});
