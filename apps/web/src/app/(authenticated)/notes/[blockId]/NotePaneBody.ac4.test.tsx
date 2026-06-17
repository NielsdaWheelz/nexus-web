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
