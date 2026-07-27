import { fetchDailyNotePage } from "@/lib/notes/api";
import { todayLocalDate } from "@/lib/localDate";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import type { LauncherTargetActivation } from "@/lib/launcher/dispatch";

export async function openTodayPage(
  activation: LauncherTargetActivation,
): Promise<void> {
  const page = await fetchDailyNotePage(todayLocalDate());
  requestWorkspaceTargetActivation({
    target: { href: `/pages/${page.id}`, labelHint: page.title },
    disposition: activation.disposition,
    modality: activation.modality,
  });
}
