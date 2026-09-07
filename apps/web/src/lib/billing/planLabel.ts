import type { BillingPlanTier } from "./useBillingAccount";

export function planLabel(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Plus";
  if (planTier === "ai_plus") return "Transcription Plus";
  if (planTier === "ai_pro") return "Transcription Pro";
  return "Free";
}
