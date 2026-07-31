import { describe, expect, it } from "vitest";
import { planWorkspaceTargetActivation } from "@/lib/workspace/targetActivation";

const MEDIA_ID = "11111111-1111-4111-8111-111111111111";
const MEDIA_HREF = `/media/${MEDIA_ID}`;
const PAGE_ID = "22222222-2222-4222-8222-222222222222";
const PAGE_HREF = `/pages/${PAGE_ID}`;
const DAILY_LOCAL_DATE = "2026-07-30";
const DAILY_HREF = `/daily/${DAILY_LOCAL_DATE}`;

function plan(input: Partial<Parameters<typeof planWorkspaceTargetActivation>[0]> = {}) {
  return planWorkspaceTargetActivation({
    originPaneId: "origin",
    target: { href: MEDIA_HREF },
    disposition: { kind: "Follow" },
    panes: [{ paneId: "origin", href: "/libraries", minimized: false }],
    maxPanes: 12,
    ...input,
  });
}

describe("planWorkspaceTargetActivation", () => {
  it("follows a missing target in the origin pane", () => {
    expect(plan()).toEqual({
      kind: "NavigateOrigin",
      paneId: "origin",
      href: MEDIA_HREF,
    });
  });

  it("activates the first visible exact pane, without changing history", () => {
    expect(
      plan({
        panes: [
          { paneId: "origin", href: "/libraries", minimized: false },
          { paneId: "minimized", href: MEDIA_HREF, minimized: true },
          { paneId: "visible", href: MEDIA_HREF, minimized: false },
        ],
      }),
    ).toEqual({ kind: "ActivateExisting", paneId: "visible" });
  });

  it("prefers the origin over duplicate exact panes", () => {
    expect(
      plan({
        panes: [
          { paneId: "origin", href: MEDIA_HREF, minimized: false },
          { paneId: "duplicate", href: MEDIA_HREF, minimized: false },
        ],
      }),
    ).toEqual({ kind: "Unchanged", paneId: "origin" });
  });

  it("restores a minimized exact pane when it is the only match", () => {
    expect(
      plan({
        panes: [
          { paneId: "origin", href: "/libraries", minimized: false },
          { paneId: "minimized", href: MEDIA_HREF, minimized: true },
        ],
      }),
    ).toEqual({ kind: "ActivateExisting", paneId: "minimized" });
  });

  it("activates a Page pane through its published daily alias", () => {
    expect(
      plan({
        target: { href: DAILY_HREF },
        panes: [
          { paneId: "origin", href: "/libraries", minimized: false },
          {
            paneId: "page",
            href: PAGE_HREF,
            minimized: false,
            aliases: [`daily:${DAILY_LOCAL_DATE}`],
          },
        ],
      }),
    ).toEqual({ kind: "ActivateExisting", paneId: "page" });
  });

  it("restores a minimized daily pane through an ordinary Page target", () => {
    expect(
      plan({
        target: { href: PAGE_HREF },
        panes: [
          { paneId: "origin", href: "/libraries", minimized: false },
          {
            paneId: "daily",
            href: DAILY_HREF,
            minimized: true,
            aliases: [`page:${PAGE_ID}`],
          },
        ],
      }),
    ).toEqual({ kind: "ActivateExisting", paneId: "daily" });
  });

  it("does not collapse query-distinct visits through their Page alias", () => {
    expect(
      plan({
        target: { href: `${PAGE_HREF}?view=outline` },
        panes: [
          { paneId: "origin", href: "/libraries", minimized: false },
          {
            paneId: "page",
            href: `${PAGE_HREF}?view=canvas`,
            minimized: false,
          },
        ],
      }),
    ).toEqual({
      kind: "NavigateOrigin",
      paneId: "origin",
      href: `${PAGE_HREF}?view=outline`,
    });
  });

  it("pushes a hash-only target in the selected exact pane", () => {
    expect(
      plan({
        target: { href: `${MEDIA_HREF}#highlight-1` },
        panes: [{ paneId: "origin", href: MEDIA_HREF, minimized: false }],
      }),
    ).toEqual({
      kind: "NavigateExisting",
      paneId: "origin",
      href: `${MEDIA_HREF}#highlight-1`,
    });
  });

  it("treats a query-distinct target as a new Follow destination", () => {
    expect(
      plan({
        target: { href: `${MEDIA_HREF}?loc=chapter-2` },
        panes: [{ paneId: "origin", href: MEDIA_HREF, minimized: false }],
      }),
    ).toEqual({
      kind: "NavigateOrigin",
      paneId: "origin",
      href: `${MEDIA_HREF}?loc=chapter-2`,
    });
  });

  it("forks even when an exact pane exists", () => {
    expect(
      plan({ panes: [{ paneId: "origin", href: MEDIA_HREF, minimized: false }], disposition: { kind: "Fork" } }),
    ).toEqual({
      kind: "CreateAfterOrigin",
      originPaneId: "origin",
      target: { href: MEDIA_HREF },
    });
  });

  it("adopts an exact destination and otherwise creates after the origin", () => {
    expect(
      plan({
        disposition: { kind: "Adopt" },
        panes: [
          { paneId: "origin", href: "/libraries", minimized: false },
          { paneId: "target", href: MEDIA_HREF, minimized: false },
        ],
      }),
    ).toEqual({ kind: "ActivateExisting", paneId: "target" });
    expect(plan({ disposition: { kind: "Adopt" } })).toEqual({
      kind: "CreateAfterOrigin",
      originPaneId: "origin",
      target: { href: MEDIA_HREF },
    });
  });

  it("rejects required creation atomically at the pane limit", () => {
    expect(
      plan({
        disposition: { kind: "Fork" },
        maxPanes: 1,
      }),
    ).toEqual({ kind: "Reject", reason: "PaneLimitReached" });
  });

  it("rejects Adopt at the pane limit but still follows in place", () => {
    expect(
      plan({ disposition: { kind: "Adopt" }, maxPanes: 1 }),
    ).toEqual({ kind: "Reject", reason: "PaneLimitReached" });
    expect(plan({ maxPanes: 1 })).toEqual({
      kind: "NavigateOrigin",
      paneId: "origin",
      href: MEDIA_HREF,
    });
  });

  it("defects for unsupported targets and missing origins", () => {
    expect(() => plan({ target: { href: "/unsupported" } })).toThrow(
      "Unsupported workspace target",
    );
    expect(() => plan({ originPaneId: "missing" })).toThrow(
      "Unknown workspace origin pane",
    );
  });
});
