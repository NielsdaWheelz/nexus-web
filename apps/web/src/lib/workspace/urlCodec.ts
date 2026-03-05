"use client";

import {
  WORKSPACE_SCHEMA_VERSION,
  WORKSPACE_STATE_PARAM,
  WORKSPACE_VERSION_PARAM,
  type WorkspaceStateV2,
  getPrimaryHrefFromWorkspaceState,
  sanitizeWorkspaceState,
} from "@/lib/workspace/schema";

export const MAX_WORKSPACE_STATE_PARAM_LENGTH = 1800;

type DecodeSource = "query" | "fallback";

export interface WorkspaceDecodeResult {
  state: WorkspaceStateV2;
  source: DecodeSource;
  errorCode:
    | null
    | "missing_query_state"
    | "unsupported_version"
    | "payload_too_large"
    | "decode_failed"
    | "parse_failed";
}

export interface WorkspaceEncodeResult {
  ok: boolean;
  value: string;
  errorCode: null | "payload_too_large" | "encode_failed";
}

function toBase64Url(raw: string): string {
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(raw: string): string {
  const paddingLength = (4 - (raw.length % 4)) % 4;
  const padded = `${raw}${"=".repeat(paddingLength)}`;
  return padded.replace(/-/g, "+").replace(/_/g, "/");
}

function encodeUtf8(value: string): string {
  if (typeof Buffer !== "undefined") {
    return toBase64Url(Buffer.from(value, "utf-8").toString("base64"));
  }
  if (typeof btoa !== "undefined") {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    for (const byte of bytes) {
      binary += String.fromCharCode(byte);
    }
    return toBase64Url(btoa(binary));
  }
  throw new Error("workspace codec: no base64 encoder available");
}

function decodeUtf8(value: string): string {
  const normalized = fromBase64Url(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(normalized, "base64").toString("utf-8");
  }
  if (typeof atob !== "undefined") {
    const binary = atob(normalized);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  throw new Error("workspace codec: no base64 decoder available");
}

function stripWorkspaceParams(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams.toString());
  next.delete(WORKSPACE_VERSION_PARAM);
  next.delete(WORKSPACE_STATE_PARAM);
  return next;
}

export function buildWorkspaceFallbackHref(
  pathname: string,
  searchParams: URLSearchParams,
  hash = ""
): string {
  const stripped = stripWorkspaceParams(searchParams);
  const qs = stripped.toString();
  return `${pathname}${qs ? `?${qs}` : ""}${hash}`;
}

export function encodeWorkspaceStateParam(state: WorkspaceStateV2): WorkspaceEncodeResult {
  try {
    const payload = encodeUtf8(JSON.stringify(state));
    if (payload.length > MAX_WORKSPACE_STATE_PARAM_LENGTH) {
      return { ok: false, value: "", errorCode: "payload_too_large" };
    }
    return { ok: true, value: payload, errorCode: null };
  } catch {
    return { ok: false, value: "", errorCode: "encode_failed" };
  }
}

export function decodeWorkspaceStateParam(
  payload: string,
  options: { fallbackHref: string; baseOrigin?: string }
): WorkspaceDecodeResult {
  if (!payload || payload.length === 0) {
    return {
      state: sanitizeWorkspaceState(null, options),
      source: "fallback",
      errorCode: "missing_query_state",
    };
  }
  if (payload.length > MAX_WORKSPACE_STATE_PARAM_LENGTH) {
    return {
      state: sanitizeWorkspaceState(null, options),
      source: "fallback",
      errorCode: "payload_too_large",
    };
  }

  try {
    const decoded = decodeUtf8(payload);
    try {
      const parsed = JSON.parse(decoded) as unknown;
      return {
        state: sanitizeWorkspaceState(parsed, options),
        source: "query",
        errorCode: null,
      };
    } catch {
      return {
        state: sanitizeWorkspaceState(null, options),
        source: "fallback",
        errorCode: "parse_failed",
      };
    }
  } catch {
    return {
      state: sanitizeWorkspaceState(null, options),
      source: "fallback",
      errorCode: "decode_failed",
    };
  }
}

export function decodeWorkspaceStateFromUrl(
  pathname: string,
  searchParams: URLSearchParams,
  options?: { hash?: string; baseOrigin?: string }
): WorkspaceDecodeResult {
  const fallbackHref = buildWorkspaceFallbackHref(pathname, searchParams, options?.hash ?? "");
  const version = searchParams.get(WORKSPACE_VERSION_PARAM);
  const encodedState = searchParams.get(WORKSPACE_STATE_PARAM);

  if (!version || !encodedState) {
    return {
      state: sanitizeWorkspaceState(null, {
        fallbackHref,
        baseOrigin: options?.baseOrigin,
      }),
      source: "fallback",
      errorCode: "missing_query_state",
    };
  }
  if (version !== String(WORKSPACE_SCHEMA_VERSION)) {
    return {
      state: sanitizeWorkspaceState(null, {
        fallbackHref,
        baseOrigin: options?.baseOrigin,
      }),
      source: "fallback",
      errorCode: "unsupported_version",
    };
  }

  return decodeWorkspaceStateParam(encodedState, {
    fallbackHref,
    baseOrigin: options?.baseOrigin,
  });
}

export function buildWorkspaceUrl(
  state: WorkspaceStateV2,
  options?: { baseOrigin?: string }
): { href: string; errorCode: WorkspaceEncodeResult["errorCode"] } {
  const primaryHref = getPrimaryHrefFromWorkspaceState(state);
  const baseOrigin =
    options?.baseOrigin ??
    (typeof window !== "undefined" &&
    window.location.origin &&
    window.location.origin !== "null"
      ? window.location.origin
      : "http://localhost");

  const parsed = new URL(primaryHref, baseOrigin);
  const params = stripWorkspaceParams(new URLSearchParams(parsed.search));
  const isTrivialState =
    state.groups.length === 1 &&
    state.groups[0]?.id === state.activeGroupId &&
    state.groups[0]?.tabs.length === 1 &&
    state.groups[0]?.activeTabId === state.groups[0]?.tabs[0]?.id &&
    typeof state.groups[0]?.widthPx === "undefined";
  if (isTrivialState) {
    const qs = params.toString();
    return {
      href: `${parsed.pathname}${qs ? `?${qs}` : ""}${parsed.hash}`,
      errorCode: null,
    };
  }

  const encoded = encodeWorkspaceStateParam(state);
  if (!encoded.ok) {
    const qs = params.toString();
    return {
      href: `${parsed.pathname}${qs ? `?${qs}` : ""}${parsed.hash}`,
      errorCode: encoded.errorCode,
    };
  }

  params.set(WORKSPACE_VERSION_PARAM, String(WORKSPACE_SCHEMA_VERSION));
  params.set(WORKSPACE_STATE_PARAM, encoded.value);
  const qs = params.toString();
  return {
    href: `${parsed.pathname}${qs ? `?${qs}` : ""}${parsed.hash}`,
    errorCode: null,
  };
}

