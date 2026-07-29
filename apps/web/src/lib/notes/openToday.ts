import { fetchDailyNotePage } from "@/lib/notes/api";
import { todayLocalDate } from "@/lib/localDate";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import type { NexusTargetActivation } from "@/lib/nexus/model";

export async function openTodayPage(
  activation: NexusTargetActivation,
): Promise<void> {
  const page = await fetchDailyNotePage(todayLocalDate());
  requestWorkspaceTargetActivation({
    target: { href: `/pages/${page.id}`, labelHint: page.title },
    disposition: activation.disposition,
    modality: activation.modality,
  });
}
