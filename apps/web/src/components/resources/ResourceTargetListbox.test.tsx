import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ResourceTargetListbox, {
  resourceTargetKey,
  resourceTargetOptionId,
} from "./ResourceTargetListbox";
import type {
  ResourceTargetPassage,
  ResourceTargetResource,
} from "@/lib/resources/resourceTargets";
import type { ResourceItem } from "@/lib/resources/resourceItems";

function resourceItem(overrides: Partial<ResourceItem> = {}): ResourceItem {
  return {
    ref: "media:11111111-1111-4111-8111-111111111111",
    scheme: "media",
    id: "11111111-1111-4111-8111-111111111111",
    label: "The Dispossessed",
    summary: "A novel by Ursula K. Le Guin",
    route: "/media/11111111-1111-4111-8111-111111111111",
    activation: {
      resourceRef: "media:11111111-1111-4111-8111-111111111111",
      kind: "route",
      href: "/media/11111111-1111-4111-8111-111111111111",
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: { userLinkSource: true, userLinkTarget: "direct", noteReferenceTarget: true },
      attachable: true,
      chatSubject: "label",
      readable: "body",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: false,
      adjacencyTarget: true,
    },
    versionByLane: {},
    ...overrides,
  };
}

function resourceTarget(
  overrides: Partial<ResourceTargetResource> = {},
): ResourceTargetResource {
  return {
    kind: "resource",
    item: resourceItem(),
    existingLinkId: null,
    ...overrides,
  };
}

function passageTarget(overrides: Partial<ResourceTargetPassage> = {}): ResourceTargetPassage {
  return {
    kind: "passage",
    candidateRef: "content_chunk:22222222-2222-4222-8222-222222222222",
    source: resourceItem({
      ref: "media:33333333-3333-4333-8333-333333333333",
      id: "33333333-3333-4333-8333-333333333333",
      label: "Left Hand of Darkness",
      scheme: "media",
    }),
    label: "Chapter 3",
    excerpt: "the <b>ansible</b> hummed quietly",
    activation: {
      resourceRef: "content_chunk:22222222-2222-4222-8222-222222222222",
      kind: "none",
      href: null,
      unresolvedReason: null,
    },
    existingLinkId: null,
    ...overrides,
  };
}

describe("ResourceTargetListbox", () => {
  it("renders resource and passage rows with the shared listbox contract", () => {
    const resource = resourceTarget();
    const passage = passageTarget();
    render(
      <ResourceTargetListbox
        id="rt"
        ariaLabel="Link targets"
        targets={[resource, passage]}
        activeKey={resourceTargetKey(resource)}
        loading={false}
        error={null}
        onHover={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    const listbox = screen.getByRole("listbox", { name: "Link targets" });
    expect(listbox).toHaveAttribute("id", "rt");

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("id", resourceTargetOptionId("rt", resource));
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[1]).toHaveAttribute("aria-selected", "false");

    expect(screen.getByText("The Dispossessed")).toBeInTheDocument();
    expect(screen.getByText("A novel by Ursula K. Le Guin")).toBeInTheDocument();

    expect(screen.getByText("Chapter 3")).toBeInTheDocument();
    expect(screen.getByText("Left Hand of Darkness")).toBeInTheDocument();
    // The `<b>` match markup renders as a real bold element, never raw HTML.
    const bold = screen.getByText("ansible");
    expect(bold.tagName).toBe("B");
  });

  it("shows a non-color-only Linked state for already-linked targets", () => {
    const target = resourceTarget({ existingLinkId: "44444444-4444-4444-8444-444444444444" });
    render(
      <ResourceTargetListbox
        id="rt"
        ariaLabel="Link targets"
        targets={[target]}
        activeKey={null}
        loading={false}
        error={null}
        onHover={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText("Linked")).toBeInTheDocument();
  });

  it("renders a loading state and no rows", () => {
    render(
      <ResourceTargetListbox
        id="rt"
        ariaLabel="Link targets"
        targets={[resourceTarget()]}
        activeKey={null}
        loading
        error={null}
        onHover={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
  });

  it("renders an empty state once settled with no targets", () => {
    render(
      <ResourceTargetListbox
        id="rt"
        ariaLabel="Link targets"
        targets={[]}
        activeKey={null}
        loading={false}
        error={null}
        emptyMessage="No matches"
        onHover={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("renders a retryable error state instead of rows", () => {
    const onRetry = vi.fn();
    render(
      <ResourceTargetListbox
        id="rt"
        ariaLabel="Link targets"
        targets={[resourceTarget()]}
        activeKey={null}
        loading={false}
        error={new Error("network down")}
        onHover={vi.fn()}
        onPick={vi.fn()}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("reports hover and pick by target", () => {
    const onHover = vi.fn();
    const onPick = vi.fn();
    const target = resourceTarget();
    render(
      <ResourceTargetListbox
        id="rt"
        ariaLabel="Link targets"
        targets={[target]}
        activeKey={null}
        loading={false}
        error={null}
        onHover={onHover}
        onPick={onPick}
      />,
    );
    const option = screen.getByRole("option");
    fireEvent.mouseMove(option);
    expect(onHover).toHaveBeenCalledWith(target);
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith(target);
  });
});
