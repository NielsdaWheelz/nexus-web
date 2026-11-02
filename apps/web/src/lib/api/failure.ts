// What a failed api call means to its reader. `transportOf` is total over modeled
// errors: every one lands in exactly one `Transport`, whose closed record states its
// lines and verb, so a caller cannot fall through to a line of its own. Domain codes are
// translated ahead of it. A same-system defect is outside it and rethrows: `Failed`
// meets that in render and reaches the boundary; `fail` tests first and throws later.
import { updateRemedy, type UpdateRemedy } from "@/lib/native/admission";
import { isSameSystemApiDefect, type ApiError } from "./client";

export type Transport = "Offline" | "SignIn" | "Update" | "Busy" | "Unavailable" | "Refused";

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
  if (error.status === 0) return navigator.onLine === false ? "Offline" : "Unavailable";
  return error.status >= 400 && error.status < 500 ? "Refused" : "Unavailable";
}

/** `Update` reloads only where `updateRemedy` says reload can work; otherwise it has no verb. */
export type TransportVerb = "Retry" | "SignIn" | "Update";
type TransportLine = { readonly fact: string; readonly reason?: string };

const couldntLoad = (noun: string) => `couldn’t load ${noun}.`;
const because = (reason: string) => (fact: string): TransportLine => ({ fact, reason });
const STALE_BUILD: Readonly<Record<UpdateRemedy, string>> = {
  Reload: "nexus updated.",
  CloseTabs: "update ready. close all nexus tabs and reopen.",
  Reinstall: "install the current nexus apk, then reopen the app.",
};
/** The one sentence for a stale build, whoever says it: a read, a command or the account. */
export const staleBuild = () => STALE_BUILD[updateRemedy()];

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
