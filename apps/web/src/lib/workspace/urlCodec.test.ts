import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  createPaneId,
  type WorkspacePaneHistory,
  type WorkspacePaneState,
} from "@/lib/workspace/schema";
import {
  buildWorkspaceUrl,
  decodeWorkspaceStateFromUrl,
  decodeWorkspaceStateParam,
  encodeWorkspaceStateParam,
} from "@/lib/workspace/urlCodec";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function makePane(
  id: string,
  href: string,
  visibility: WorkspacePaneState["visibility"] = "visible",
  history: WorkspacePaneHistory = { back: [], forward: [] }
): WorkspacePaneState {
  return { id, href, primaryWidthPx: 480, sidecar: null, visibility, history };
}

describe("workspace url codec", () => {
  it("round-trips encoded workspace state", () => {
    const base = createDefaultWorkspaceState("/libraries", workspacePrimaryMetrics);
    const state = {
      ...base,
      panes: [
        ...base.panes,
        makePane(createPaneId(), "/conversations", "minimized"),
      ],
    };

    const encoded = encodeWorkspaceStateParam(state);
    expect(encoded.ok).toBe(true);
    const decoded = decodeWorkspaceStateParam(encoded.value, {
      fallbackHref: "/libraries",
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.errorCode).toBeNull();
    expect(decoded.state.panes).toHaveLength(2);
    expect(decoded.state.panes[1]?.visibility).toBe("minimized");
  });

  it("preserves media pane widths above the standard pane cap", () => {
    const base = createDefaultWorkspaceState("/media/123", workspacePrimaryMetrics, 2200);
    const secondId = createPaneId();
    const state = {
      ...base,
      panes: [...base.panes, makePane(secondId, "/libraries")],
    };

    const encoded = encodeWorkspaceStateParam(state);
    expect(encoded.ok).toBe(true);
    const decoded = decodeWorkspaceStateParam(encoded.value, {
      fallbackHref: "/libraries",
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.errorCode).toBeNull();
    expect(decoded.state.panes[0]?.primaryWidthPx).toBe(2200);
  });

  it("falls back when the URL state version is unsupported", () => {
    const params = new URLSearchParams();
    params.set("wsv", "3");
    params.set("ws", "abc");
    const decoded = decodeWorkspaceStateFromUrl("/media/1", params, {
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.source).toBe("fallback");
    expect(decoded.errorCode).toBe("unsupported_version");
    expect(decoded.state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
  });

  it("rejects stale workspace URLs", () => {
    const params = new URLSearchParams();
    params.set("wsv", String(WORKSPACE_SCHEMA_VERSION - 1));
    params.set("ws", "abc");
    const decoded = decodeWorkspaceStateFromUrl("/libraries", params, {
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.source).toBe("fallback");
    expect(decoded.errorCode).toBe("unsupported_version");
    expect(decoded.state.panes[0]?.href).toBe("/libraries");
  });

  it("keeps URL clean for trivial single-pane state", () => {
    const state = createDefaultWorkspaceState(
      "/media/123?foo=bar",
      workspacePrimaryMetrics,
    );
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.pathname).toBe("/media/123");
    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get("wsv")).toBeNull();
    expect(parsed.searchParams.get("ws")).toBeNull();
  });

  it("keeps workspace params for a single pane with history", () => {
    const state = createDefaultWorkspaceState(
      "/media/123?foo=bar",
      workspacePrimaryMetrics,
    );
    state.panes[0]!.history.back.push("/libraries");

    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.searchParams.get("wsv")).toBe(String(WORKSPACE_SCHEMA_VERSION));
    expect(parsed.searchParams.get("ws")).toBeTruthy();
  });

  it("keeps workspace params for a single pane with sidecar state", () => {
    const state = createDefaultWorkspaceState(
      "/media/123?foo=bar",
      workspacePrimaryMetrics,
    );
    state.panes[0]!.sidecar = {
      groupId: "reader-tools",
      activeSurfaceId: "reader-highlights",
      widthPx: 360,
      visibility: "visible",
    };

    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.searchParams.get("wsv")).toBe(String(WORKSPACE_SCHEMA_VERSION));
    expect(parsed.searchParams.get("ws")).toBeTruthy();
  });

  it("round-trips pane history", () => {
    const state = createDefaultWorkspaceState("/media/123", workspacePrimaryMetrics);
    state.panes[0]!.history = {
      back: ["/libraries", "/media/122"],
      forward: ["/media/124"],
    };

    const encoded = encodeWorkspaceStateParam(state);
    expect(encoded.ok).toBe(true);
    const decoded = decodeWorkspaceStateParam(encoded.value, {
      fallbackHref: "/libraries",
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.state.panes[0]?.history).toEqual(state.panes[0]?.history);
  });

  it("infers workspace state when URL has no workspace params", () => {
    const decoded = decodeWorkspaceStateFromUrl("/libraries", new URLSearchParams(), {
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.source).toBe("inferred");
    expect(decoded.errorCode).toBeNull();
    expect(decoded.state.panes).toHaveLength(1);
  });

  it("appends workspace params when state has multiple panes", () => {
    const base = createDefaultWorkspaceState(
      "/media/123?foo=bar",
      workspacePrimaryMetrics,
    );
    const secondId = createPaneId();
    const state = {
      ...base,
      activePaneId: secondId,
      panes: [...base.panes, makePane(secondId, "/conversations")],
    };
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.pathname).toBe("/conversations");
    expect(parsed.searchParams.get("wsv")).toBe(String(WORKSPACE_SCHEMA_VERSION));
    expect(parsed.searchParams.get("ws")).toBeTruthy();
  });

  it("includes minimized panes in non-trivial workspace URLs", () => {
    const base = createDefaultWorkspaceState("/media/123", workspacePrimaryMetrics);
    const secondId = createPaneId();
    const state = {
      ...base,
      panes: [...base.panes, makePane(secondId, "/conversations", "minimized")],
    };
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    const encoded = parsed.searchParams.get("ws");
    expect(encoded).toBeTruthy();

    const decoded = decodeWorkspaceStateParam(encoded ?? "", {
      fallbackHref: "/libraries",
      baseOrigin: "http://localhost",
      workspacePrimaryMetrics,
    });
    expect(decoded.state.panes.map((pane) => pane.visibility)).toEqual([
      "visible",
      "minimized",
    ]);
  });
});
