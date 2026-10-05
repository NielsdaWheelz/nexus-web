import { redirect } from "next/navigation";
import { callFastAPI } from "@/lib/api/server";
import type { ApiJson } from "@/lib/api/wire";
import { formatLocalDateInTimeZone } from "@/lib/localDate";

export default async function Page() {
  const response = await callFastAPI<ApiJson<"/me", "get">>("/me");
  const localDate = formatLocalDateInTimeZone(
    new Date(),
    response.data.calendar_time_zone,
  );
  redirect(`/daily/${localDate}`);
}
