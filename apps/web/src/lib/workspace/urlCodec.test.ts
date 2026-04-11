import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
  createPaneId,
} from "@/lib/workspace/schema";
import {
  buildWorkspaceUrl,
  decodeWorkspaceStateFromUrl,
  decodeWorkspaceStateParam,
  encodeWorkspaceStateParam,
} from "@/lib/workspace/urlCodec";

describe("workspace url codec", () => {
  it("round-trips encoded workspace state", () => {
    const base = createDefaultWorkspaceState("/libraries");
    const state = {
      ...base,
      panes: [
        ...base.panes,
        { id: createPaneId(), href: "/conversations", widthPx: 480 },
      ],
    };

    const encoded = encodeWorkspaceStateParam(state);
    expect(encoded.ok).toBe(true);
    const decoded = decodeWorkspaceStateParam(encoded.value, {
      fallbackHref: "/libraries",
      baseOrigin: "http://localhost",
    });
    expect(decoded.errorCode).toBeNull();
    expect(decoded.state.panes).toHaveLength(2);
  });

  it("falls back when URL version is unsupported", () => {
    const params = new URLSearchParams();
    params.set("wsv", "999");
    params.set("ws", "abc");
    const decoded = decodeWorkspaceStateFromUrl("/media/1", params, {
      baseOrigin: "http://localhost",
    });
    expect(decoded.source).toBe("fallback");
    expect(decoded.errorCode).toBe("unsupported_version");
    expect(decoded.state.schemaVersion).toBe(WORKSPACE_SCHEMA_VERSION);
  });

  it("keeps URL clean for trivial single-pane state", () => {
    const state = createDefaultWorkspaceState("/media/123?foo=bar");
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.pathname).toBe("/media/123");
    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get("wsv")).toBeNull();
    expect(parsed.searchParams.get("ws")).toBeNull();
  });

  it("infers workspace state when URL has no workspace params", () => {
    const decoded = decodeWorkspaceStateFromUrl("/libraries", new URLSearchParams(), {
      baseOrigin: "http://localhost",
    });
    expect(decoded.source).toBe("inferred");
    expect(decoded.errorCode).toBeNull();
    expect(decoded.state.panes).toHaveLength(1);
  });

  it("appends workspace params when state has multiple panes", () => {
    const base = createDefaultWorkspaceState("/media/123?foo=bar");
    const secondId = createPaneId();
    const state = {
      ...base,
      activePaneId: secondId,
      panes: [...base.panes, { id: secondId, href: "/conversations", widthPx: 480 }],
    };
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.pathname).toBe("/conversations");
    expect(parsed.searchParams.get("wsv")).toBe(String(WORKSPACE_SCHEMA_VERSION));
    expect(parsed.searchParams.get("ws")).toBeTruthy();
  });
});
