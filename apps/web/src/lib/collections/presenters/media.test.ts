import { describe, expect, it, vi } from "vitest";
import type { ContributorCredit } from "@/lib/contributors/types";
import { decodePublicationDate } from "@/lib/dates/publicationDate";
import {
  presentMedia,
  type MediaPresenterContext,
  type MediaPresenterItem,
} from "./media";

function item(overrides: Partial<MediaPresenterItem> = {}): MediaPresenterItem {
  return {
    id: "media-1",
    kind: "pdf",
    title: "On Exactitude in Science",
    canonical_source_url: "https://example.test/borges.pdf",
    processing_status: "ready_for_reading",
    read_state: "unread",
    progressFraction: { kind: "Absent" },
    capabilities: { can_quote: true },
    publicationDate: {
      kind: "Present",
      value: decodePublicationDate("1946", "date"),
    },
    sourceHost: { kind: "Absent" },
    contributors: [],
    ...overrides,
  };
}

function ctx(overrides: Partial<MediaPresenterContext> = {}): MediaPresenterContext {
  return {
    canManageLibraries: false,
    readingTimeEstimate: { kind: "Absent" },
    ...overrides,
  };
}

describe("presentMedia", () => {
  it("projects the canonical media identity without publisher or thumbnail chrome", () => {
    const view = presentMedia(item(), ctx());

    expect(view.primary).toEqual({
      kind: "link",
      href: "/media/media-1",
      paneLabelHint: "On Exactitude in Science",
      viewTransition: "media-reader",
    });
    expect(view.title).toEqual({ text: "On Exactitude in Science" });
    expect(view.publicationDate).toEqual({ kind: "Present", value: "1946" });
    expect(view).not.toHaveProperty("publisher");
    expect(view).not.toHaveProperty("lead");
    expect(view.relatedMediaId).toEqual({ kind: "Present", value: "media-1" });
  });

  it("uses the source host only for web articles", () => {
    expect(
      presentMedia(
        item({
          kind: "web_article",
          sourceHost: { kind: "Present", value: "example.test" },
        }),
        ctx(),
      ).context,
    ).toEqual({ kind: "Present", value: { kind: "Text", text: "example.test" } });
    expect(presentMedia(item({ kind: "pdf" }), ctx()).context).toEqual({
      kind: "Absent",
    });
  });

  it("preserves numeric reading-time and progress facts", () => {
    const readingTimeEstimate = {
      kind: "Present" as const,
      value: {
        totalMinutes: { value: 15 },
        remainingMinutes: { kind: "Present" as const, value: { value: 5 } },
      },
    };
    const unread = presentMedia(item(), ctx({ readingTimeEstimate }));
    const inProgress = presentMedia(
      item({
        read_state: "in_progress",
        progressFraction: { kind: "Present", value: { value: 0.5 } },
      }),
      ctx({ readingTimeEstimate }),
    );
    const finished = presentMedia(
      item({
        read_state: "finished",
        progressFraction: { kind: "Present", value: { value: 1 } },
      }),
      ctx({ readingTimeEstimate }),
    );

    expect(unread.activity).toEqual({
      kind: "Present",
      value: {
        kind: "Unread",
        modality: "Read",
        totalMinutes: { kind: "Present", value: { value: 15 } },
      },
    });
    expect(inProgress.activity).toEqual({
      kind: "Present",
      value: {
        kind: "InProgress",
        modality: "Read",
        fraction: { kind: "Present", value: { value: 0.5 } },
        remainingMinutes: { kind: "Present", value: { value: 5 } },
      },
    });
    expect(finished.activity).toEqual({
      kind: "Present",
      value: { kind: "Finished", modality: "Read" },
    });
  });

  it("omits an unquantified in-progress activity", () => {
    expect(
      presentMedia(
        item({ read_state: "in_progress", progressFraction: { kind: "Absent" } }),
        ctx(),
      ).activity,
    ).toEqual({ kind: "Absent" });
  });

  it("keeps exceptional processing explicit and ready silent", () => {
    expect(
      presentMedia(item({ processing_status: "failed" }), ctx()).exceptionalStatus,
    ).toEqual({
      kind: "Present",
      value: { kind: "MediaProcessing", status: "failed" },
    });
    expect(presentMedia(item(), ctx()).exceptionalStatus).toEqual({ kind: "Absent" });
  });

  it("preserves contributor credits and truthful actions", () => {
    const credits: ContributorCredit[] = [
      {
        contributor_handle: "borges",
        credited_name: "Jorge Luis Borges",
        role: "author",
      },
    ];
    const view = presentMedia(
      item({ contributors: credits, capabilities: { can_quote: true, can_delete: true } }),
      ctx({ canManageLibraries: true, onDelete: vi.fn(), onManageLibraries: vi.fn() }),
    );

    expect(view.contributors).toEqual(credits);
    expect(view.actions.map((action) => action.id)).toEqual(
      expect.arrayContaining(["delete-media", "manage-media-libraries"]),
    );
    expect(view).not.toHaveProperty("swipeActions");
  });
});
