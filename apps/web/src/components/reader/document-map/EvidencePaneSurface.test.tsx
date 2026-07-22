"use client";

import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type {
  ReaderEvidence,
  ReaderEvidenceHighlight,
  ReaderEvidenceObject,
  ReaderEvidenceUserEdge,
} from "@/lib/reader/documentMap";
import { useEvidenceFilters } from "@/lib/reader/useEvidenceFilters";
import EvidencePaneSurface from "./EvidencePaneSurface";
import type { EvidenceHighlightActions } from "./EvidenceItemRow";

const absent = { kind: "Absent" } as const;
const mediaObject: ReaderEvidenceObject = {
  ref: "media:linked",
  kind: "Media",
  label: "Linked work",
  excerpt: { kind: "Present", value: "A linked excerpt" },
  activation: {
    resourceRef: "media:linked",
    kind: "route",
    href: "/media/linked",
    unresolvedReason: null,
  },
};

function highlight(id: string): ReaderEvidenceHighlight {
  return {
    id: `highlight:${id}`,
    kind: "Highlight",
    highlight_id: id,
    label: `Highlight ${id}`,
    excerpt: { kind: "Present", value: `Quote ${id}` },
    associations: [],
    quote: `Quote ${id}`,
    prefix: "",
    suffix: "",
    color: "yellow",
    created_at: "2026-07-20T00:00:00Z",
    updated_at: "2026-07-20T00:00:00Z",
    author_user_id: "user-1",
    is_owner: true,
  };
}

function evidence(): ReaderEvidence {
  const first = highlight("h1");
  first.associations = [
    {
      relationship: "DirectlyAttached",
      object: mediaObject,
      edge_id: "edge-associated",
      role: "context",
      origin: "user",
      direction: "Outgoing",
    },
  ];
  return {
    counts: {
      highlights: 2,
      citations: 2,
      links: 1,
      synapses: 1,
      passages: 5,
      document: 1,
    },
    passage_groups: [
      {
        locus_ref: "highlight:h1",
        resolution: {
          kind: "Resolved",
          anchor: {
            locator: {
              type: "web_text_offsets",
              media_id: "media-1",
              fragment_id: "fragment-1",
              start_offset: 1,
              end_offset: 8,
            },
            passage_anchor_id: null,
          },
          order_key: "document:0001",
        },
        target_excerpt: { kind: "Present", value: "Quote h1" },
        items: [
          first,
          highlight("h2"),
          {
            id: "source-reference:ref-1",
            kind: "SourceReference",
            label: "Footnote one",
            excerpt: absent,
            associations: [],
            stable_key: "ref-1",
            apparatus_kind: "footnote_ref",
            confidence: "exact",
            targets: [],
          },
          {
            id: "generated-citation:edge-c1",
            kind: "GeneratedCitation",
            label: "Generated citation",
            excerpt: absent,
            associations: [{ relationship: "AuthoredIn", object: mediaObject }],
            edge_id: "edge-c1",
            role: "context",
          },
        ],
        also_references: [
          { relationship: "AlsoReferences", object: mediaObject },
        ],
      },
      {
        locus_ref: "evidence_span:stale",
        resolution: { kind: "Unavailable", reason: "Stale" },
        target_excerpt: absent,
        items: [
          {
            id: "synapse:edge-s1",
            kind: "Synapse",
            label: "Resonance",
            excerpt: absent,
            associations: [],
            edge_id: "edge-s1",
            role: "context",
            rationale: "These passages resonate.",
            object: mediaObject,
          },
        ],
        also_references: [],
      },
    ],
    document_items: [
      {
        id: "link:edge-l1",
        kind: "Link",
        label: "Document relation",
        excerpt: absent,
        associations: [],
        edge_id: "edge-l1",
        role: "context",
        origin: "user",
        object: mediaObject,
      },
    ],
  };
}

function actions(): EvidenceHighlightActions {
  return {
    canQuoteToChat: false,
    focusedHighlightId: null,
    isEditingBounds: false,
    isReflowable: true,
    onFocusHighlight: vi.fn(),
    onQuoteToChat: vi.fn(),
    onLink: vi.fn(),
    onColorChange: vi.fn(async () => {}),
    onDelete: vi.fn(async () => {}),
    onStartEditBounds: vi.fn(),
    onCancelEditBounds: vi.fn(),
    onNoteSave: vi.fn(async (_highlightId, noteBlockId) => ({
      note_block_id: noteBlockId ?? "note-1",
      body_pm_json: {},
      body_text: "",
    })),
    onNoteDelete: vi.fn(async () => {}),
    onOpenNoteLink: vi.fn(),
  };
}

function Harness({
  source = evidence(),
  activeItemId = null,
  followGeneration = 0,
  aggregateStatus = "ready",
  activatePassage = vi.fn(() => true),
  onRemoveUserEdge = vi.fn(),
  onSaveLinkNote = vi.fn().mockResolvedValue({ note_block_id: "nb-new" }),
  onDeleteLinkNote = vi.fn().mockResolvedValue(undefined),
}: {
  source?: ReaderEvidence | null;
  activeItemId?: string | null;
  followGeneration?: number;
  aggregateStatus?: "ready" | "empty" | "partial";
  activatePassage?: (
    group: ReaderEvidence["passage_groups"][number],
  ) => boolean;
  onRemoveUserEdge?: (edge: ReaderEvidenceUserEdge) => void;
  onSaveLinkNote?: (
    linkId: string,
    noteBlockId: string,
    bodyPmJson: Record<string, unknown>,
  ) => Promise<{ note_block_id: string }>;
  onDeleteLinkNote?: (linkId: string) => Promise<void>;
}) {
  const filters = useEvidenceFilters();
  return (
    <FeedbackProvider>
      <EvidencePaneSurface
        evidence={source}
        filters={filters}
        activeItemId={activeItemId}
        followGeneration={followGeneration}
        hoveredItemId={null}
        loading={false}
        error={null}
        aggregateStatus={aggregateStatus}
        highlightActions={actions()}
        onActivatePassage={activatePassage}
        onActivateObject={vi.fn()}
        onActivateSourceTarget={vi.fn()}
        onHoverItem={vi.fn()}
        onDismissSynapse={vi.fn()}
        onRemoveUserEdge={onRemoveUserEdge}
        onSaveLinkNote={onSaveLinkNote}
        onDeleteLinkNote={onDeleteLinkNote}
      />
    </FeedbackProvider>
  );
}

describe("EvidencePaneSurface", () => {
  it("uses one accessible scope tabset and keeps passage failures visible", async () => {
    render(<Harness />);
    expect(screen.getByRole("tab", { name: /Passages 5/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("Footnote one")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Needs attention" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The source changed after this target was created."),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("tab", { name: /Whole document 1/ }),
    );
    expect(screen.getByText("Document relation")).toBeInTheDocument();
    expect(screen.queryByText("Footnote one")).not.toBeInTheDocument();
  });

  it("supports independent semantic filters and an all-off recovery", async () => {
    render(<Harness />);
    const filterGroup = screen.getByRole("group", { name: "Evidence types" });
    for (const label of ["Highlights", "Citations", "Links", "Synapses"]) {
      await userEvent.click(
        within(filterGroup).getByRole("button", { name: new RegExp(label) }),
      );
    }
    expect(
      screen.getByText("No evidence matches these filters."),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText("Footnote one")).toBeInTheDocument();
  });

  it("keeps target-owned passage identity and activity stable across filters", async () => {
    const source = evidence();
    source.passage_groups[0]!.target_excerpt = {
      kind: "Present",
      value: "Canonical target text",
    };
    render(<Harness source={source} activeItemId="highlight:h1" />);
    const jump = screen.getByRole("button", {
      name: "Jump to Canonical target text",
    });
    expect(jump).toHaveAttribute("aria-current", "location");

    await userEvent.click(screen.getByRole("button", { name: /Highlights 2/ }));

    expect(screen.getByText("Canonical target text")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Jump to Canonical target text" }),
    ).toHaveAttribute("aria-current", "location");
  });

  it("resumes passage follow only after a successful parent activation", async () => {
    const failedActivation = vi.fn(() => false);
    const { rerender } = render(
      <Harness
        activeItemId="highlight:h1"
        followGeneration={1}
        activatePassage={failedActivation}
      />,
    );
    await userEvent.click(
      screen.getByRole("tab", { name: /Whole document 1/ }),
    );
    fireEvent.wheel(screen.getByText("Document relation"));
    expect(
      screen.getByRole("button", { name: "Return to current passage" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Return to current passage" }),
    );
    expect(screen.getByRole("tab", { name: /Passages 5/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    const passageList = screen.getByLabelText("Passage evidence");
    fireEvent.pointerDown(passageList);
    expect(
      screen.getByRole("button", { name: "Return to current passage" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Return to current passage" }),
    );
    passageList.focus();
    fireEvent.keyDown(passageList, { key: "PageDown" });
    expect(
      screen.getByRole("button", { name: "Return to current passage" }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Return to current passage" }),
    );

    fireEvent.wheel(screen.getAllByText("Quote h1")[0]!);
    await userEvent.click(
      screen.getByRole("button", { name: "Jump to Quote h1" }),
    );
    expect(failedActivation).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", { name: "Return to current passage" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("tab", { name: /Whole document 1/ }),
    );
    fireEvent.wheel(screen.getByText("Document relation"));
    rerender(
      <Harness
        activeItemId="highlight:h1"
        followGeneration={2}
        activatePassage={failedActivation}
      />,
    );
    expect(screen.getByRole("tab", { name: /Passages 5/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Return to current passage" }),
    ).not.toBeInTheDocument();
  });

  it("surfaces a partial aggregate without hiding available evidence", () => {
    render(<Harness aggregateStatus="partial" />);
    expect(
      screen.getByText("Some document evidence is unavailable."),
    ).toBeInTheDocument();
    expect(screen.getByText("Footnote one")).toBeInTheDocument();
  });

  it("opens associations lazily and mounts at most one highlight editor", async () => {
    render(<Harness />);
    expect(screen.queryByText("A linked excerpt")).not.toBeInTheDocument();
    await userEvent.click(
      screen.getAllByRole("button", { name: "1 linked object" })[0]!,
    );
    expect(screen.getByText("A linked excerpt")).toBeInTheDocument();

    const actionMenus = screen.getAllByRole("button", {
      name: "Highlight actions",
    });
    await userEvent.click(actionMenus[0]!);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add note" }));
    expect(
      screen.getAllByRole("textbox", { name: "Highlight note" }),
    ).toHaveLength(1);
    await userEvent.click(actionMenus[1]!);
    await userEvent.click(screen.getByRole("menuitem", { name: "Add note" }));
    expect(
      screen.getAllByRole("textbox", { name: "Highlight note" }),
    ).toHaveLength(1);
  });

  it("distinguishes an empty corpus from a filtered empty view", () => {
    render(
      <Harness
        source={{
          counts: {
            highlights: 0,
            citations: 0,
            links: 0,
            synapses: 0,
            passages: 0,
            document: 0,
          },
          passage_groups: [],
          document_items: [],
        }}
      />,
    );
    expect(
      screen.getByText(
        "No highlights, citations, links, or Synapses in this document.",
      ),
    ).toBeInTheDocument();
  });

  it("distinguishes an intrinsically empty scope from a filtered scope", async () => {
    const onlyPassages = evidence();
    onlyPassages.document_items = [];
    onlyPassages.counts.document = 0;
    onlyPassages.counts.links = 0;
    render(<Harness source={onlyPassages} />);

    await userEvent.click(
      screen.getByRole("tab", { name: /Whole document 0/ }),
    );
    expect(
      screen.getByText("No whole-document evidence in this document."),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Show all" }),
    ).not.toBeInTheDocument();
  });

  describe("folded user association controls", () => {
    it.each(["context", "supports", "contradicts"] as const)(
      "removes an explicit user %s association by its typed edge fact",
      async (role) => {
        const source = evidence();
        const item = source.passage_groups[0]!.items[0]!;
        if (item.kind !== "Highlight")
          throw new Error("Expected Highlight fixture");
        item.associations = [
          {
            relationship: "DirectlyAttached",
            object: mediaObject,
            edge_id: `edge-${role}`,
            role,
            origin: "user",
            direction: "Outgoing",
          },
        ];
        const onRemoveUserEdge = vi.fn();
        render(<Harness source={source} onRemoveUserEdge={onRemoveUserEdge} />);

        await userEvent.click(
          screen.getAllByRole("button", { name: "1 linked object" })[0]!,
        );
        await userEvent.click(
          screen.getByRole("button", {
            name: "Remove connection to Linked work",
          }),
        );

        expect(onRemoveUserEdge).toHaveBeenCalledWith(
          expect.objectContaining({
            relationship: "DirectlyAttached",
            edge_id: `edge-${role}`,
            role,
            origin: "user",
          }),
        );
      },
    );

    it("does not mint removal for a generated folded association", async () => {
      const source = evidence();
      const item = source.passage_groups[0]!.items[0]!;
      if (item.kind !== "Highlight")
        throw new Error("Expected Highlight fixture");
      item.associations = [
        {
          relationship: "DirectlyAttached",
          object: mediaObject,
          edge_id: "edge-citation",
          role: "context",
          origin: "citation",
          direction: "Incoming",
        },
      ];
      render(<Harness source={source} />);

      await userEvent.click(
        screen.getAllByRole("button", { name: "1 linked object" })[0]!,
      );
      expect(
        screen.queryByRole("button", {
          name: "Remove connection to Linked work",
        }),
      ).not.toBeInTheDocument();
    });
  });

  describe("stable user Link controls", () => {
    it("removes a stable user Link via the typed user-edge contract", async () => {
      const onRemoveUserEdge = vi.fn();
      render(<Harness onRemoveUserEdge={onRemoveUserEdge} />);
      await userEvent.click(
        screen.getByRole("tab", { name: /Whole document 1/ }),
      );
      await userEvent.click(
        screen.getByRole("button", { name: "Remove link Document relation" }),
      );
      expect(onRemoveUserEdge).toHaveBeenCalledWith(
        expect.objectContaining({
          edge_id: "edge-l1",
          kind: "Link",
          origin: "user",
          role: "context",
        }),
      );
    });

    it("toggles a single link-note editor from the Link row", async () => {
      render(<Harness />);
      await userEvent.click(
        screen.getByRole("tab", { name: /Whole document 1/ }),
      );
      const noteButton = screen.getByRole("button", {
        name: "Note on link Document relation",
      });
      await userEvent.click(noteButton);
      expect(
        screen.getByRole("button", { name: "Done editing note" }),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Done editing note" }),
      );
      expect(
        screen.queryByRole("button", { name: "Done editing note" }),
      ).not.toBeInTheDocument();
    });

    it("keeps note controls exclusive to neutral user Links", async () => {
      const source = evidence();
      const link = source.document_items[0]!;
      if (link.kind !== "Link") throw new Error("Expected Link fixture");
      link.role = "supports";
      render(<Harness source={source} />);
      await userEvent.click(
        screen.getByRole("tab", { name: /Whole document 1/ }),
      );

      expect(
        screen.getByRole("button", { name: "Remove link Document relation" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: "Note on link Document relation",
        }),
      ).not.toBeInTheDocument();
    });

    it("exposes neither removal nor notes for a generated Link row", async () => {
      const source = evidence();
      const link = source.document_items[0]!;
      if (link.kind !== "Link") throw new Error("Expected Link fixture");
      link.origin = "citation";
      render(<Harness source={source} />);
      await userEvent.click(
        screen.getByRole("tab", { name: /Whole document 1/ }),
      );

      expect(
        screen.queryByRole("button", { name: "Remove link Document relation" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: "Note on link Document relation",
        }),
      ).not.toBeInTheDocument();
    });
  });
});
