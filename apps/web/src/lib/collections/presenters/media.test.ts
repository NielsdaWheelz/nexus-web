import { describe, expect, it, vi } from "vitest";
import type { ContributorCredit } from "@/lib/contributors/types";
import { presentMedia, type MediaPresenterContext, type MediaPresenterItem } from "./media";

function item(overrides: Partial<MediaPresenterItem> = {}): MediaPresenterItem {
  return {
    id: "media-1",
    kind: "pdf",
    title: "On Exactitude in Science",
    canonical_source_url: "https://example.test/borges.pdf",
    processing_status: "ready_for_reading",
    publisher: "Universal Press",
    published_date: "1946",
    contributors: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<MediaPresenterContext> = {}): MediaPresenterContext {
  return {
    canManageLibraries: false,
    ...overrides,
  };
}

describe("presentMedia", () => {
  it("maps a media item to a media-kind row linking to its reader pane", () => {
    const view = presentMedia(item(), ctx());

    expect(view.kind).toBe("media");
    expect(view.primary).toEqual({
      kind: "link",
      href: "/media/media-1",
      paneTitleHint: "On Exactitude in Science",
      viewTransition: "media-reader",
    });
    expect(view.headline.text).toBe("On Exactitude in Science");
  });

  it("sets a lead icon", () => {
    const view = presentMedia(item(), ctx());
    expect(view.lead.icon).toBeDefined();
  });

  it("surfaces publisher and published date as signals", () => {
    const view = presentMedia(item(), ctx());

    const values = view.signals.map((s) => s.value);
    expect(values).toContain("Universal Press");
    expect(values).toContain("1946");
  });

  it("omits absent publisher/date signals", () => {
    const view = presentMedia(
      item({ publisher: null, published_date: null }),
      ctx(),
    );
    expect(view.signals).toEqual([]);
  });

  it("emits a danger status pill for failed processing", () => {
    const view = presentMedia(item({ processing_status: "failed" }), ctx());
    expect(view.status).toEqual({ tone: "danger", label: "Failed" });
  });

  it("emits no status pill once ready for reading", () => {
    const view = presentMedia(
      item({ processing_status: "ready_for_reading" }),
      ctx(),
    );
    expect(view.status).toBeUndefined();
  });

  it("carries contributor credits when present", () => {
    const credits: ContributorCredit[] = [
      {
        contributor_handle: "borges",
        credited_name: "Jorge Luis Borges",
        role: "author",
      },
    ];
    const view = presentMedia(item({ contributors: credits }), ctx());
    expect(view.contributors).toEqual({ credits, maxVisible: 3 });
  });

  it("builds a non-empty action list when the subject has capabilities and callbacks", () => {
    const onDelete = vi.fn();
    const onManageLibraries = vi.fn();
    const view = presentMedia(
      item({ capabilities: { can_delete: true } }),
      ctx({ canManageLibraries: true, onDelete, onManageLibraries }),
    );

    expect(view.actions?.length).toBeGreaterThan(0);
    const ids = view.actions?.map((a) => a.id) ?? [];
    expect(ids).toContain("delete-media");
    expect(ids).toContain("manage-media-libraries");
    expect(view.swipeActions?.[0]).toMatchObject({
      id: "delete-media",
      label: "Delete document",
      tone: "danger",
    });
  });
});
