import { describe, expect, it } from "vitest";
import { resolveWorkspaceActivationRouteId } from "@/lib/panes/paneIdentity";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { mergeSwitchboardRows } from "./merge";
import type { SwitchboardRowModel } from "./model";

const subject = {
  kind: "Resource",
  ref: "media:00000000-0000-0000-0000-000000000001",
  activation: {
    resourceRef: "media:00000000-0000-0000-0000-000000000001",
    kind: "route",
    href: "/media/00000000-0000-0000-0000-000000000001",
    unresolvedReason: null,
  },
  missing: false,
} as ResourceActionSubject;

function pane(
  id: string,
  label: string,
  href = `/media/${id}`,
): SwitchboardRowModel {
  return {
    id: `OpenPane:${id}`,
    item: {
      kind: "OpenPane",
      paneId: id,
      activationRouteId: resolveWorkspaceActivationRouteId(href),
    },
    label,
    metadata: "Open tab",
    recent: false,
  };
}

function resource(input: {
  ref: string;
  label: string;
  route: string;
  match: "Exact" | "Metadata" | "Deep";
}): SwitchboardRowModel {
  return {
    id: `Resource:${input.ref}`,
    item: {
      kind: "Resource",
      occurrenceRef: input.ref,
      ownerRef: subject.ref,
      activationRouteId: resolveWorkspaceActivationRouteId(input.route),
      subject,
      label: input.label,
      summary: "Matching passage",
      match: input.match,
    },
    label: input.label,
    metadata: "Matching passage",
    recent: false,
  };
}

describe("mergeSwitchboardRows", () => {
  it("orders exact panes, exact resources, recent labels, metadata, then deep", () => {
    const rows = [
      resource({ ref: "deep", label: "Other", route: "other", match: "Deep" }),
      { ...pane("recent", "Other"), recent: true },
      resource({
        ref: "metadata",
        label: "Other",
        route: "other",
        match: "Metadata",
      }),
      resource({
        ref: "exact",
        label: "Needle",
        route: "other",
        match: "Exact",
      }),
      pane("exact", "Needle"),
    ];
    expect(
      mergeSwitchboardRows({
        query: "needle",
        previous: [],
        incoming: rows,
        activeId: null,
      }).map((row) => row.id),
    ).toEqual([
      "OpenPane:exact",
      "Resource:exact",
      "OpenPane:recent",
      "Resource:metadata",
      `OwnerGroup:${subject.ref}`,
      "Resource:deep",
    ]);
  });

  it("represents an open owner by its pane while retaining deep occurrences beneath it", () => {
    const open = pane("media", "Book", "/media/owner");
    const direct = resource({
      ref: "direct",
      label: "Book",
      route: "/media/owner",
      match: "Exact",
    });
    const deep = resource({
      ref: "deep",
      label: "Passage",
      route: "/media/owner",
      match: "Deep",
    });
    const rows = mergeSwitchboardRows({
      query: "book",
      previous: [],
      incoming: [direct, deep, open],
      activeId: null,
    });
    expect(rows.map((row) => row.id)).toEqual(["OpenPane:media", "Resource:deep"]);
    expect(rows[1]?.parentId).toBe("OpenPane:media");
  });

  it("projects a nonmatching open owner pane for a matching deep occurrence", () => {
    const open = pane("media", "A title without the query", "/media/owner");
    const deep = resource({
      ref: "deep",
      label: "Needle passage",
      route: "/media/owner",
      match: "Deep",
    });
    const rows = mergeSwitchboardRows({
      query: "needle",
      previous: [],
      incoming: [deep],
      ownerPanes: [open],
      activeId: null,
    });
    expect(rows.map((row) => row.id)).toEqual(["OpenPane:media", "Resource:deep"]);
    expect(rows[1]?.parentId).toBe("OpenPane:media");
  });

  it("uses the first policy-ordered pane when duplicate tabs share a route", () => {
    const preferred = pane("preferred", "Current", "/media/owner");
    const duplicate = pane("duplicate", "Duplicate", "/media/owner");
    const deep = resource({
      ref: "deep",
      label: "Needle passage",
      route: "/media/owner",
      match: "Deep",
    });
    const rows = mergeSwitchboardRows({
      query: "needle",
      previous: [],
      incoming: [deep],
      ownerPanes: [preferred, duplicate],
      activeId: null,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "OpenPane:preferred",
      "Resource:deep",
    ]);
  });

  it("groups deep occurrences under a direct owning resource when no pane is open", () => {
    const owner = resource({
      ref: subject.ref,
      label: "Book",
      route: "/media/owner",
      match: "Metadata",
    });
    const deep = resource({
      ref: "deep",
      label: "Needle passage",
      route: "/media/owner",
      match: "Deep",
    });
    const rows = mergeSwitchboardRows({
      query: "needle",
      previous: [],
      incoming: [deep, owner],
      activeId: null,
    });
    expect(rows.map((row) => row.id)).toEqual([
      `Resource:${subject.ref}`,
      "Resource:deep",
    ]);
    expect(rows[1]?.parentId).toBe(`Resource:${subject.ref}`);
  });

  it("synthesizes an owner group for a deep-only result", () => {
    const deep = resource({
      ref: "deep",
      label: "Needle passage",
      route: "/media/owner",
      match: "Deep",
    });
    const rows = mergeSwitchboardRows({
      query: "needle",
      previous: [],
      incoming: [deep],
      activeId: null,
    });
    expect(rows.map((row) => row.id)).toEqual([
      `OwnerGroup:${subject.ref}`,
      "Resource:deep",
    ]);
    expect(rows[0]?.item).toBeNull();
    expect(rows[1]?.parentId).toBe(`OwnerGroup:${subject.ref}`);
  });

  it("does not move the active row or rows above it when remote rows arrive", () => {
    const first = pane("first", "First");
    const active = pane("active", "Active");
    const exact = resource({
      ref: "exact",
      label: "Needle",
      route: "other",
      match: "Exact",
    });
    expect(
      mergeSwitchboardRows({
        query: "needle",
        previous: [first, active],
        incoming: [exact, first, active],
        activeId: active.id,
      }).map((row) => row.id),
    ).toEqual([first.id, active.id, exact.id]);
  });
});
