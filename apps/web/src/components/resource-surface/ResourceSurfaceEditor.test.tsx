import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ResourceSurfaceEditor from "./ResourceSurfaceEditor";

const PAGE_REF = "page:11111111-1111-4111-8111-111111111111";
const NOTE_REF = "note_block:22222222-2222-4222-8222-222222222222";

function response(data: unknown) {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function item(ref: string, scheme: string, id: string, label = "") {
  return {
    ref, scheme, id, label, summary: "", route: null,
    activation: { resource_ref: ref, kind: "none", href: null, unresolved_reason: null },
    missing: false,
    capabilities: {
      user_relation: { user_link_source: false, user_link_target: "none", note_reference_target: false },
      sharing: "None", library_placement: "None", attachable: false, chat_subject: "none", readable: "none", inspectable: "none", citable_result_type: null, citation_output_source: false, app_search_scope: false, conversation_search_scope: false, prompt_render: "none", expansion_policy: "none", expandable: false, adjacency_source: true, adjacency_target: true,
    },
    version_by_lane: { title: 1, body: 1, outgoing_edges: 1 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ResourceSurfaceEditor", () => {
  it("renders only direct ordered rows below the page masthead", async () => {
    const fetchMock = vi.fn(async () => response({
      source: { item: item(PAGE_REF, "page", PAGE_REF.slice(5)), content: { kind: "page_title", title: "Today" } },
      ordered_items: [
        { occurrence_id: "edge-note", target: { item: item(NOTE_REF, "note_block", NOTE_REF.slice(11)), content: { kind: "note_body", body_pm_json: { type: "paragraph", content: [{ type: "text", text: "First" }] }, body_text: "First" } } },
        { occurrence_id: "edge-media", target: { item: item("media:33333333-3333-4333-8333-333333333333", "media", "33333333-3333-4333-8333-333333333333", "Reading"), content: { kind: "resource_summary" } } },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <div data-testid="mobile-host" style={{ width: 390, maxWidth: 390 }}>
        <ResourceSurfaceEditor sourceRef={PAGE_REF} />
      </div>,
    );

    expect(await screen.findByRole("textbox", { name: "Page title" })).toHaveValue("Today");
    expect(screen.getByRole("region", { name: "Ordered resources" })).toBeVisible();
    expect(await screen.findByRole("textbox", { name: "Edit note 1" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Open Reading" })).toBeVisible();
    expect(screen.queryByText("Companion")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const host = screen.getByTestId("mobile-host");
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
  });

  it("moves focus into the optimistic right note after Enter splits a row", async () => {
    const firstSurface = {
      source: {
        item: item(PAGE_REF, "page", PAGE_REF.slice(5)),
        content: { kind: "page_title", title: "Today" },
      },
      ordered_items: [
        {
          occurrence_id: "edge-note",
          target: {
            item: item(NOTE_REF, "note_block", NOTE_REF.slice(11)),
            content: {
              kind: "note_body",
              body_pm_json: {
                type: "paragraph",
                content: [{ type: "text", text: "First" }],
              },
              body_text: "First",
            },
          },
        },
      ],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") return response(firstSurface);
      const request = JSON.parse(String(init.body)) as {
        command: { note_id: string };
      };
      return response({
        client_mutation_id: "split",
        surface: {
          ...firstSurface,
          source: {
            ...firstSurface.source,
            item: {
              ...firstSurface.source.item,
              version_by_lane: { title: 1, body: 1, outgoing_edges: 2 },
            },
          },
          ordered_items: [
            firstSurface.ordered_items[0],
            {
              occurrence_id: "edge-right",
              target: {
                item: item(
                  `note_block:${request.command.note_id}`,
                  "note_block",
                  request.command.note_id,
                ),
                content: {
                  kind: "note_body",
                  body_pm_json: { type: "paragraph" },
                  body_text: "",
                },
              },
            },
          ],
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<ResourceSurfaceEditor sourceRef={PAGE_REF} />);

    const first = await screen.findByRole("textbox", { name: "Edit note 1" });
    await userEvent.click(first);
    await userEvent.keyboard("{End}{Enter}");

    await vi.waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Edit note 2" }),
      ).toHaveFocus(),
    );
  });
});
