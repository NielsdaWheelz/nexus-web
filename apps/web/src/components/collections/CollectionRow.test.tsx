import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ResourceList from "@/components/ui/ResourceList";
import { absent, present } from "@/lib/api/presence";
import type { CollectionRowView } from "@/lib/collections/types";
import { decodePublicationDate } from "@/lib/dates/publicationDate";
import CollectionRow from "./CollectionRow";

function baseRow(): CollectionRowView {
  return {
    id: "media-1",
    kind: "media",
    primary: { kind: "link", href: "/media/media-1" },
    title: { text: "Canonical title" },
    contributors: [],
    publicationDate: absent(),
    context: absent(),
    activity: absent(),
    exceptionalStatus: absent(),
    connections: absent(),
    relatedMediaId: absent(),
    actions: [],
    selected: false,
  };
}

describe("CollectionRow", () => {
  it("renders the canonical identity, support, and activity hierarchy", () => {
    const row: CollectionRowView = {
      ...baseRow(),
      contributors: [
        {
          contributor_handle: "ada",
          contributor_display_name: "Ada Author",
          credited_name: "Ada Author",
          role: "author",
          href: "/authors/ada",
        },
        {
          contributor_handle: "grace",
          contributor_display_name: "Grace Author",
          credited_name: "Grace Author",
          role: "author",
          href: "/authors/grace",
        },
        {
          contributor_handle: "third",
          contributor_display_name: "Third Author",
          credited_name: "Third Author",
          role: "author",
          href: "/authors/third",
        },
      ],
      publicationDate: present(decodePublicationDate("2025-02-03", "date")),
      context: present({
        kind: "Snippet",
        segments: [
          { text: "A ", emphasized: false },
          { text: "matched", emphasized: true },
          { text: " context", emphasized: false },
        ],
      }),
      activity: present({
        kind: "InProgress",
        modality: "Read",
        fraction: { kind: "Present", value: { value: 0.42 } },
        remainingMinutes: { kind: "Present", value: { value: 5 } },
      }),
    };

    render(
      <ResourceList ariaLabel="Documents">
        <CollectionRow row={row} />
      </ResourceList>,
    );

    const title = screen.getByRole("link", { name: "Canonical title" });
    const firstContributor = screen.getByRole("link", { name: "Ada Author" });
    expect(title).not.toContainElement(firstContributor);
    expect(screen.getByRole("listitem")).toHaveTextContent(
      /Ada Author, Grace Author, \+1.*February 3, 2025.*A matched context/,
    );
    expect(screen.getByText("42% · ≈5 min left")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(
      screen.getByText("42 percent complete, about 5 minutes left to read"),
    ).toHaveClass("sr-only");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("keeps exceptional status singular and domain actions in the overflow", async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    render(
      <ResourceList ariaLabel="Documents">
        <CollectionRow
          row={{
            ...baseRow(),
            activity: present({ kind: "Finished", modality: "Read" }),
            exceptionalStatus: present({
              kind: "PodcastSync",
              status: "partial",
            }),
            actions: [
              {
                kind: "command",
                id: "archive",
                label: "Archive",
                onSelect: onArchive,
              },
            ],
          }}
        />
      </ResourceList>,
    );

    expect(screen.getByText("Partial sync")).toBeVisible();
    expect(screen.queryByText("Finished")).toBeNull();
    const trigger = screen.getByRole("button", {
      name: "More actions for Canonical title",
    });
    expect(trigger.getBoundingClientRect().width).toBeGreaterThanOrEqual(24);
    expect(trigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(onArchive).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps related retrieval lazy until its menu disclosure opens", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: { peers: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    try {
      render(
        <ResourceList ariaLabel="Documents">
          <CollectionRow
            row={{
              ...baseRow(),
              relatedMediaId: present("media-1"),
            }}
          />
        </ResourceList>,
      );

      expect(fetchSpy).not.toHaveBeenCalled();
      await user.click(
        screen.getByRole("button", {
          name: "More actions for Canonical title",
        }),
      );
      await user.click(
        screen.getByRole("menuitem", {
          name: "Show connections and related",
        }),
      );
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
      expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/media/media-1/related");
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
