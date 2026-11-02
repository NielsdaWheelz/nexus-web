import { TRANSPORT_LINES, type Transport } from "@/lib/api/failure";
import { remoteAdmission } from "@/lib/native/admission";

/** Why remote work waits now, in the transport's own words, so it never says offline under
 * sign-in. Pure, unlike `admissionRefusal`, so a disabled reason may read it in render. */
export function admissionReason(): string {
  let transport: Transport;
  switch (remoteAdmission()) {
    case "SignInRequired": transport = "SignIn"; break;
    case "UpdateRequired": transport = "Update"; break;
    case "Checking":
    case "Unavailable":
    case "Ready":
      transport = navigator.onLine === false ? "Offline" : "Unavailable";
  }
  return TRANSPORT_LINES[transport].command("").reason ?? "";
}
