// What a failed api call means to its reader. `transportOf` is total over modeled
// errors: every one lands in exactly one `Transport`, whose closed record states its
// lines and verb, so a caller cannot fall through to a line of its own. Domain codes are
// translated ahead of it. A same-system defect is outside it and rethrows: `Failed`
// meets that in render and reaches the boundary; `fail` tests first and throws later.
import { androidShellDocument } from "@/lib/androidShell";
import { installedApp } from "@/lib/native/admission";
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

/** `Update`'s verb is the account's: reload, or none where reload cannot replace the build. */
export type TransportVerb = "Retry" | "SignIn" | "Update";

const couldntLoad = (noun: string) => `couldn’t load ${noun}.`;
const STALE_BUILD = installedApp || androidShellDocument ? "install the current nexus apk, then reopen the app." : "nexus updated.";

/** `read` is a read's whole line, for a plural noun. `reason` runs in after a command's own
 * fact; null leaves it to the owner's domain line. */
export const TRANSPORT_LINES: Readonly<Record<Transport, {
  readonly read: (noun: string) => { readonly fact: string; readonly reason?: string };
  readonly reason: string | null;
  readonly verb: TransportVerb | null;
}>> = {
  Offline: { read: noun => ({ fact: `${noun} load when you’re back online.` }), reason: "you’re offline.", verb: null },
  SignIn: { read: noun => ({ fact: `sign in to see ${noun}.` }), reason: "sign in to continue.", verb: "SignIn" },
  Update: { read: () => ({ fact: STALE_BUILD }), reason: STALE_BUILD, verb: "Update" },
  Busy: { read: noun => ({ fact: couldntLoad(noun), reason: "nexus is busy." }), reason: "nexus is busy.", verb: "Retry" },
  Unavailable: { read: noun => ({ fact: couldntLoad(noun), reason: "nexus isn’t answering." }), reason: "nexus isn’t answering.", verb: "Retry" },
  Refused: { read: noun => ({ fact: couldntLoad(noun) }), reason: null, verb: "Retry" },
};
