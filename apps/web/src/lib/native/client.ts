"use client";

// Fixed native operations only. The bridge is current-document and main-frame
// scoped by Android. Requests never carry an account identity or credentials.
import { isRecord } from "@/lib/validation";
import { ApiError, readResponse, WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { SettingsIdentity, EmailChangeResult, IdentityDeleteResult } from "@/lib/account/settingsWire";
import type { WorkspaceState } from "@/lib/workspace/model";
import type { CatalogStatus, DeviceStartup, RemoteAdmission, SignInResult } from "./contracts";
import { bindSessionCheck, publishAdmission, observeRemoteFailure } from "./admission";

type Port = { postMessage(frame: string): void; onmessage: ((event: { data: unknown }) => void) | null };
type Reply = { id: number; ok: true } & Record<string, unknown>;
const port = typeof window === "undefined" ? undefined : (window as Window & { nexusApp?: Port }).nexusApp;
let nextId = 1;
const waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
function invalidReply(): ApiError {
  return new ApiError(500, "E_INVALID_RESPONSE", "invalid native app reply");
}
function readAdmission(value: unknown): RemoteAdmission {
  switch (value) {
    case "Checking": case "Ready": case "Unavailable": case "SignInRequired": case "UpdateRequired": return value;
    default: throw invalidReply();
  }
}
const catalogListeners = new Set<(status: CatalogStatus) => void>();
function readCatalogStatusValue(value: unknown): CatalogStatus {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "last_error,refreshing,snapshot" || typeof value.refreshing !== "boolean") throw invalidReply();
  const snapshot = value.snapshot;
  const error = value.last_error;
  if (snapshot !== null && (!isRecord(snapshot) || Object.keys(snapshot).sort().join(",") !== "captured_at,consumption_revision,snapshot_id" || typeof snapshot.snapshot_id !== "string" || typeof snapshot.captured_at !== "string" || !Number.isFinite(Date.parse(snapshot.captured_at)) ||
    typeof snapshot.consumption_revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(snapshot.consumption_revision))) throw invalidReply();
  if (error !== null && (!isRecord(error) || Object.keys(error).sort().join(",") !== "code,message" || typeof error.code !== "string" || typeof error.message !== "string")) throw invalidReply();
  return { snapshot: snapshot === null ? null : { snapshot_id: String(snapshot.snapshot_id), captured_at: String(snapshot.captured_at), consumption_revision: String(snapshot.consumption_revision) }, refreshing: value.refreshing,
    last_error: error === null ? null : { code: String(error.code), message: String(error.message) } };
}
export function subscribeCatalogStatus(listener: (status: CatalogStatus) => void): () => void {
  catalogListeners.add(listener);
  return () => { catalogListeners.delete(listener); };
}
export async function readCatalogStatus(): Promise<CatalogStatus> { return readCatalogStatusValue((await call("catalog_status")).catalog); }
export async function refreshCatalog(): Promise<CatalogStatus> { return readCatalogStatusValue((await call("catalog_refresh")).catalog); }
if (port) port.onmessage = ({ data }) => {
  try {
    const frame: unknown = JSON.parse(typeof data === "string" ? data : "");
    if (!isRecord(frame)) throw invalidReply();
    if ("kind" in frame) {
      if (frame.kind === "catalog_changed") {
        const status = readCatalogStatusValue(frame.catalog);
        for (const listener of catalogListeners) listener(status);
        return;
      }
      if (frame.kind !== "session_changed") throw invalidReply();
      publishAdmission(readAdmission(frame.remote_admission));
      return;
    }
    if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id) || typeof frame.ok !== "boolean") throw invalidReply();
    const pending = waiting.get(frame.id);
    if (!frame.ok) {
      const error = frame.error;
      if (!isRecord(error) || typeof error.code !== "string" || typeof error.message !== "string" || typeof error.status !== "number" || !Number.isInteger(error.status)) throw invalidReply();
      waiting.delete(frame.id);
      observeRemoteFailure(error.status);
      pending?.reject(new ApiError(error.status, error.code, error.message));
      return;
    }
    waiting.delete(frame.id);
    if (pending) pending.resolve({ ...frame, id: frame.id, ok: true });
  } catch (error) {
    const failure = error instanceof ApiError ? error : invalidReply();
    for (const pending of waiting.values()) pending.reject(failure);
    waiting.clear();
    publishAdmission("Unavailable");
    reportError(failure);
  }
};
function call(op: string, input: Record<string, unknown> = {}): Promise<Reply> {
  if (!port) return Promise.reject(new Error("native app bridge unavailable"));
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      waiting.delete(id);
      reject(new ApiError(0, "E_NATIVE_TIMEOUT", "native operation did not acknowledge completion"));
    }, op === "session_sign_in" ? 300_000 : 30_000);
    waiting.set(id, {
      resolve: reply => { clearTimeout(timer); resolve(reply); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    port.postMessage(JSON.stringify({ id, op, ...input }));
  });
}
export async function readDeviceStartup(): Promise<DeviceStartup | null> {
  const response = await fetch("/_nexus/device/startup.json", { cache: "no-store", headers: { [WIRE_HEADER]: String(WIRE_REVISION) } });
  if (response.status === 204) return null;
  return readResponse<DeviceStartup>(response);
}
export async function hello(): Promise<void> {
  const reply = await call("hello");
  publishAdmission(readAdmission(reply.remote_admission));
}
let checking: Promise<void> | null = null;
export function sessionCheck(): Promise<void> {
  if (checking) return checking;
  checking = call("session_check").then(reply => { publishAdmission(readAdmission(reply.remote_admission)); }).finally(() => { checking = null; });
  return checking;
}
bindSessionCheck(() => sessionCheck().catch(() => publishAdmission("Unavailable")));
/** The first check drains any pre-edit native foreground/job check; the second
 * starts after the confirmed edit and acknowledges its durable local settings. */
export async function refreshDeviceSettings(): Promise<void> {
  await sessionCheck();
  await sessionCheck();
}
export async function sessionSignIn(): Promise<SignInResult> {
  const { result } = await call("session_sign_in");
  switch (result) {
    case "Restored": case "Cancelled": case "DifferentAccount": case "Failed": return result;
    default: throw invalidReply();
  }
}
export async function sessionSignOut(): Promise<void> { await call("session_sign_out"); }
export async function accountEmailChange(email: string): Promise<{ data: EmailChangeResult }> {
  const reply = await call("account_email_change", { email });
  return { data: reply.data as EmailChangeResult };
}
export async function accountIdentitiesGet(): Promise<{ data: SettingsIdentity[] }> {
  const reply = await call("account_identities_get");
  return { data: reply.data as SettingsIdentity[] };
}
export async function accountIdentityDelete(identity_id: string): Promise<{ data: IdentityDeleteResult }> {
  const reply = await call("account_identity_delete", { identity_id });
  return { data: reply.data as IdentityDeleteResult };
}
/** Temporary transfer; commit is the only acknowledgement of durable state.
 * An uncertain result is reconciled from the committed snapshot by the save owner. */
export async function saveDeviceWorkspace(state: WorkspaceState, expected_revision: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const { write_id } = await call("workspace_begin", { expected_revision, byte_count: bytes.length });
  if (typeof write_id !== "string" || write_id.length === 0) throw invalidReply();
  for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
    const chunk = bytes.subarray(offset, offset + 24 * 1024);
    const base64 = btoa(String.fromCharCode(...chunk));
    const reply = await call("workspace_chunk", { write_id, offset, base64 });
    if (reply.next_offset !== offset + chunk.length) throw new Error("native workspace offset mismatch");
  }
  const { workspace_revision } = await call("workspace_commit", { write_id });
  if (typeof workspace_revision !== "string" || !/^(0|[1-9][0-9]*)$/.test(workspace_revision)) throw invalidReply();
  return workspace_revision;
}
