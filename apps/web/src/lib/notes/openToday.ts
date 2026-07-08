import { fetchDailyNotePage } from "@/lib/notes/api";
import { todayLocalDate } from "@/lib/localDate";
import { requestOpenInAppPane } from "@/lib/panes/openInAppPane";

export async function openTodayPage(): Promise<void> {
  const page = await fetchDailyNotePage(todayLocalDate());
  requestOpenInAppPane(`/pages/${page.id}`, { titleHint: page.title });
}
