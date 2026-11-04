// What a failed api call means to its reader. `transportOf` is total over modeled
// errors: every one lands in exactly one `Transport`, whose closed record states its
// lines and verb, so a caller cannot fall through to a line of its own. Domain codes are
// translated ahead of it. A same-system defect is outside it and rethrows: `Failed`
// meets that in render and reaches the boundary; `fail` tests first and throws later.
import { remoteAdmission, updateRemedy, type UpdateRemedy } from "@/lib/native/admission";
import type { RemoteAdmission } from "@/lib/native/contracts";
import { admissionError, isSameSystemApiDefect, type ApiError } from "./client";

export type Transport = "Offline" | "SignIn" | "Update" | "Busy" | "Unavailable" | "Refused";

/** A status-0 failure is `Offline` if the browser was offline when it was observed, so a failure
 * seen offline reads offline until its owner's repair read replaces it. */
export function transportOf(error: ApiError): Transport {
  if (isSameSystemApiDefect(error)) throw error;
  switch (error.code) {
    case "E_UNAUTHENTICATED":
    case "E_ACCOUNT_MISMATCH":
      return "SignIn";
    case "E_WIRE_MISMATCH":
      return "Update";
    case "E_DATABASE_BUSY":
    case "E_RATE_LIMITED":
    case "E_AUTH_UNAVAILABLE":
      return "Busy";
  }
  if (error.status === 0) return error.offline ? "Offline" : "Unavailable";
  return error.status >= 400 && error.status < 500 ? "Refused" : "Unavailable";
}

/** Why admission holds remote work back now: the transport of the request it would refuse. Null
 * while nothing refuses it: admitted, or still checking. */
export function admissionTransport(admission: RemoteAdmission): Transport | null {
  return admission === "Checking" || admission === "Ready" ? null : transportOf(admissionError(admission));
}

/** The current admission gate's reason; ready and checking have no refusal to explain. */
export function admissionReason(): string | null {
  const transport = admissionTransport(remoteAdmission());
  return transport === null ? null : TRANSPORT_LINES[transport].command("").reason ?? null;
}

/** `Update` reloads only where `updateRemedy` says reload can work; otherwise it has no verb. */
export type TransportVerb = "Retry" | "SignIn" | "Update";
type TransportLine = { readonly fact: string; readonly reason?: string };

const couldntLoad = (noun: string) => `couldn’t load ${noun}.`;
const because = (reason: string) => (fact: string): TransportLine => ({ fact, reason });
const STALE_BUILD: Readonly<Record<UpdateRemedy, string>> = {
  Reload: "nexus updated.",
  CloseTabs: "update ready. close nexus tabs and reopen.",
  Reinstall: "install the current nexus apk, then reopen.",
};
/** The one sentence for a stale build, whoever says it: a read, a command or the account. */
export const staleBuild = () => STALE_BUILD[updateRemedy()];
/** The one reason for a write whose outcome is unknown (`outcomeUnknown`), whoever holds it. */
export const UNKNOWN_OUTCOME_REASON = "it may have gone through.";

/** `read` is a read's whole line, for a plural noun. `command` runs the reason in after a
 * command's own fact; `Refused` has none, leaving it to the owner's domain line. */
export const TRANSPORT_LINES: Readonly<Record<Transport, {
  readonly read: (noun: string) => TransportLine;
  readonly command: (fact: string) => TransportLine;
  readonly verb: TransportVerb | null;
}>> = {
  Offline: { read: noun => ({ fact: `${noun} load when you’re back online.` }), command: because("you’re offline."), verb: null },
  SignIn: { read: noun => ({ fact: `sign in to see ${noun}.` }), command: because("sign in to continue."), verb: "SignIn" },
  Update: { read: () => ({ fact: staleBuild() }), command: fact => ({ fact, reason: staleBuild() }), verb: "Update" },
  Busy: { read: noun => ({ fact: couldntLoad(noun), reason: "nexus is busy." }), command: because("nexus is busy."), verb: "Retry" },
  Unavailable: { read: noun => ({ fact: couldntLoad(noun), reason: "nexus isn’t answering." }), command: because("nexus isn’t answering."), verb: "Retry" },
  Refused: { read: noun => ({ fact: couldntLoad(noun) }), command: fact => ({ fact }), verb: "Retry" },
};
