import { describe, expect, it } from "vitest";
import {
  WORKSPACE_SCHEMA_VERSION,
  createDefaultWorkspaceState,
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
    const secondGroup = {
      id: "group-two",
      activeTabId: "tab-two",
      tabs: [{ id: "tab-two", href: "/conversations" }],
    };
    const state = {
      ...base,
      activeGroupId: secondGroup.id,
      groups: [...base.groups, secondGroup],
    };

    const encoded = encodeWorkspaceStateParam(state);
    expect(encoded.ok).toBe(true);
    const decoded = decodeWorkspaceStateParam(encoded.value, {
      fallbackHref: "/libraries",
      baseOrigin: "http://localhost",
    });
    expect(decoded.errorCode).toBeNull();
    expect(decoded.state.activeGroupId).toBe(secondGroup.id);
    expect(decoded.state.groups).toHaveLength(2);
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

  it("keeps URL clean for trivial single-tab workspace state", () => {
    const state = createDefaultWorkspaceState("/media/123?foo=bar");
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.pathname).toBe("/media/123");
    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get("wsv")).toBeNull();
    expect(parsed.searchParams.get("ws")).toBeNull();
  });

  it("appends workspace params when state has multiple pane groups", () => {
    const base = createDefaultWorkspaceState("/media/123?foo=bar");
    const state = {
      ...base,
      activeGroupId: "group-two",
      groups: [
        ...base.groups,
        {
          id: "group-two",
          activeTabId: "tab-two",
          tabs: [{ id: "tab-two", href: "/conversations" }],
        },
      ],
    };
    const result = buildWorkspaceUrl(state, { baseOrigin: "http://localhost" });
    expect(result.errorCode).toBeNull();
    const parsed = new URL(result.href, "http://localhost");
    expect(parsed.pathname).toBe("/conversations");
    expect(parsed.searchParams.get("wsv")).toBe(String(WORKSPACE_SCHEMA_VERSION));
    expect(parsed.searchParams.get("ws")).toBeTruthy();
  });
});
