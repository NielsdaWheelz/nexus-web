import type { BillingPlanTier } from "./useBillingAccount";

export function planLabel(planTier: BillingPlanTier): string {
  if (planTier === "plus") return "Plus";
  if (planTier === "ai_plus") return "AI Plus";
  if (planTier === "ai_pro") return "AI Pro";
  return "Free";
}
