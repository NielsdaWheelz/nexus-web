import { useSyncExternalStore } from "react";
import { transportVerbs, type CommandVerb, type Verbs } from "@/components/feedback/stage";
import { TRANSPORT_LINES, type Transport } from "@/lib/api/failure";
import { remoteAdmission, remoteAttemptAllowed, subscribeAdmission } from "@/lib/native/admission";

/** Why remote work waits now, in the transport's own words, so it never says offline under
 * sign-in. Null while nothing has refused it: admitted, or still checking, when a gated control
 * waits busy instead. Pure, unlike `admissionRefusal`, so a disabled reason may read it in render. */
export function admissionReason(): string | null {
  let transport: Transport;
  switch (remoteAdmission()) {
    case "Ready":
    case "Checking":
      return null;
    case "SignInRequired": transport = "SignIn"; break;
    case "UpdateRequired": transport = "Update"; break;
    case "Unavailable": transport = navigator.onLine === false ? "Offline" : "Unavailable";
  }
  return TRANSPORT_LINES[transport].command("").reason ?? null;
}

/** A held write's verbs as admission stands, for a resend that goes through apiFetch: the resend
 * waits busy while admission checks, and is disabled with admission's reason while it would be
 * refused unsent; a stale build offers reload alone, where reload can work. Subscribed, so the
 * hold's owner renders again as admission moves. */
export function useResendVerbs(): (resend: CommandVerb) => Verbs {
  const admission = useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
  return resend => (admission === "UpdateRequired" ? transportVerbs("Update", { signIn: null }) : null)
    ?? [{ ...resend, busy: resend.busy || admission === "Checking",
      disabledReason: remoteAttemptAllowed() ? undefined : admissionReason() ?? undefined }];
}
