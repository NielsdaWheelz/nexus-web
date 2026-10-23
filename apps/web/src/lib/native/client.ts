"use client";

// Fixed native operations only. The bridge is current-document and main-frame
// scoped by Android. Requests never carry an account identity or credentials.
import { ApiError, readResponse, WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import type { SettingsIdentity, EmailChangeResult, IdentityDeleteResult } from "@/lib/account/settingsWire";
import type { WorkspaceState } from "@/lib/workspace/model";
import type { DeviceStartup, RemoteAdmission, SignInResult } from "./contracts";
import { bindSessionCheck, publishAdmission } from "./admission";

type Port = { postMessage(frame: string): void; onmessage: ((event: { data: unknown }) => void) | null };
type Reply = { id: number; ok: true } & Record<string, unknown>;
type Frame = Reply | { id: number; ok: false; error: { code: string; message: string; status?: number } } | { kind: "session_changed"; remote_admission: RemoteAdmission };
const port = typeof window === "undefined" ? undefined : (window as Window & { nexusApp?: Port }).nexusApp;
let nextId = 1;
const waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
if (port) port.onmessage = ({ data }) => {
  const frame = JSON.parse(data as string) as Frame;
  if ("kind" in frame) return publishAdmission(frame.remote_admission);
  const pending = waiting.get(frame.id);
  if (!pending) return;
  waiting.delete(frame.id);
  if (frame.ok) pending.resolve(frame);
  else pending.reject(new ApiError(frame.error.status ?? 0, frame.error.code, frame.error.message));
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
  publishAdmission(reply.remote_admission as RemoteAdmission);
}
let checking: Promise<void> | null = null;
export function sessionCheck(): Promise<void> {
  if (checking) return checking;
  checking = call("session_check").then(reply => { publishAdmission(reply.remote_admission as RemoteAdmission); }).finally(() => { checking = null; });
  return checking;
}
bindSessionCheck(() => sessionCheck().catch(() => publishAdmission("Unavailable")));
/** Settings refresh must follow any check that began before the server edit. */
export async function refreshDeviceSettings(): Promise<void> {
  if (checking) await checking;
  await sessionCheck();
}
export async function sessionSignIn(): Promise<SignInResult> {
  return (await call("session_sign_in")).result as SignInResult;
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
  for (let offset = 0; offset < bytes.length; offset += 24 * 1024) {
    const chunk = bytes.subarray(offset, offset + 24 * 1024);
    const base64 = btoa(String.fromCharCode(...chunk));
    const reply = await call("workspace_chunk", { write_id, offset, base64 });
    if (reply.next_offset !== offset + chunk.length) throw new Error("native workspace offset mismatch");
  }
  return (await call("workspace_commit", { write_id })).workspace_revision as string;
}
