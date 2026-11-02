import { useSyncExternalStore } from "react";
import { transportVerbs, type CommandVerb } from "@/components/feedback/stage";
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

/** A held write's verb (its resend, or a check that reads) as admission stands now: a stale build
 * offers reload alone, where reload can work; otherwise the verb waits busy while admission
 * checks, and is disabled with admission's reason while `sends`, the owner's own gate, would keep
 * it unsent. Pure: its owner renders again as admission moves. */
export function resendVerbs(resend: CommandVerb, sends: () => boolean): readonly [CommandVerb] {
  const admission = remoteAdmission();
  const reload = admission === "UpdateRequired" ? transportVerbs("Update", { signIn: null })?.[0] : undefined;
  if (reload !== undefined && "run" in reload) return [reload];
  return [{ ...resend, busy: resend.busy || admission === "Checking",
    disabledReason: sends() ? undefined : admissionReason() ?? undefined }];
}

/** `resendVerbs` for a verb that goes through apiFetch, subscribed to admission. */
export function useResendVerbs(): (resend: CommandVerb) => readonly [CommandVerb] {
  useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
  return resend => resendVerbs(resend, remoteAttemptAllowed);
}
