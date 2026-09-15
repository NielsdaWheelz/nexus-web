import type { SessionVerification } from "@/lib/auth/dal";
import type { AuthReturnTarget } from "@/lib/auth/redirects";
import { AuthDependencyError } from "@/lib/auth/session-response";

export type LoginEntryPlan =
  | { readonly kind: "Render" }
  | { readonly kind: "Target"; readonly target: AuthReturnTarget }
  | { readonly kind: "Recover"; readonly target: AuthReturnTarget };

type SessionVerificationReader = () => Promise<SessionVerification>;

export async function planLoginEntry(
  target: AuthReturnTarget,
  verify: SessionVerificationReader,
): Promise<LoginEntryPlan> {
  let verification: SessionVerification;
  try {
    verification = await verify();
  } catch (error) {
    if (error instanceof AuthDependencyError) {
      return { kind: "Recover", target };
    }
    throw error;
  }

  switch (verification.kind) {
    case "Verified":
      return { kind: "Target", target };
    case "Anonymous":
      return { kind: "Render" };
    case "RefreshRequired":
    case "SessionEnded":
      return { kind: "Recover", target };
  }

  verification satisfies never;
}
