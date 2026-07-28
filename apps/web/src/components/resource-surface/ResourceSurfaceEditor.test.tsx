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
  const href = scheme === "media" ? `/media/${id}` : null;
  return {
    ref, scheme, id, label, summary: "", route: href,
    activation: {
      resourceRef: ref,
      kind: scheme === "media" ? "route" : "none",
      href,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: { title: 1, body: 1, outgoing_edges: 1 },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("ResourceSurfaceEditor", () => {
  it("renders only direct ordered rows below the page masthead", async () => {
    const activateTarget = vi.fn();
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
        <ResourceSurfaceEditor
          sourceRef={PAGE_REF}
          activateTarget={activateTarget}
        />
      </div>,
    );

    expect(await screen.findByRole("textbox", { name: "Page title" })).toHaveValue("Today");
    expect(screen.getByRole("region", { name: "Ordered resources" })).toBeVisible();
    expect(await screen.findByRole("textbox", { name: "Edit note 1" })).toBeVisible();
    const reading = screen.getByRole("button", { name: "Open Reading" });
    expect(reading).toBeVisible();
    await userEvent.click(reading);
    expect(activateTarget).toHaveBeenCalledWith({
      target: {
        href: "/media/33333333-3333-4333-8333-333333333333",
        labelHint: "Reading",
      },
      disposition: { kind: "Follow" },
    });
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
              versionByLane: { title: 1, body: 1, outgoing_edges: 2 },
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
    render(
      <ResourceSurfaceEditor sourceRef={PAGE_REF} activateTarget={vi.fn()} />,
    );

    const first = await screen.findByRole("textbox", { name: "Edit note 1" });
    await userEvent.click(first);
    await userEvent.keyboard("{End}{Enter}");

    await vi.waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Edit note 2" }),
      ).toHaveFocus(),
    );
  });

  it("resolves a note object reference through the required target capability", async () => {
    const activateTarget = vi.fn();
    const pageId = "33333333-3333-4333-8333-333333333333";
    const pageRef = `page:${pageId}`;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/locators/resolve")) {
        return response({
          resolutions: [{
            locator: { kind: "resource_ref", ref: pageRef },
            resourceItem: {
              ...item(pageRef, "page", pageId, "Project"),
              route: `/pages/${pageId}`,
              activation: {
                resourceRef: pageRef,
                kind: "route",
                href: `/pages/${pageId}`,
                unresolvedReason: null,
              },
            },
            canonicalHref: `/pages/${pageId}`,
          }],
        });
      }
      return response({
        source: {
          item: item(NOTE_REF, "note_block", NOTE_REF.slice(11)),
          content: {
            kind: "note_body",
            body_pm_json: {
              type: "paragraph",
              content: [{
                type: "object_ref",
                attrs: { objectType: "page", objectId: pageId, label: "Project" },
              }],
            },
            body_text: "Project",
          },
        },
        ordered_items: [],
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <ResourceSurfaceEditor sourceRef={NOTE_REF} activateTarget={activateTarget} />,
    );

    await userEvent.click(await screen.findByRole("link", { name: "Open Project" }));

    await vi.waitFor(() =>
      expect(activateTarget).toHaveBeenCalledWith({
        target: { href: `/pages/${pageId}` },
        disposition: { kind: "Follow" },
      }),
    );
  });
});
