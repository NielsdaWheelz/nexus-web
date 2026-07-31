import { redirect } from "next/navigation";
import { callFastAPI } from "@/lib/api/server";
import { decodeAuthenticatedAccount } from "@/lib/account/contract";
import { formatLocalDateInTimeZone } from "@/lib/localDate";

export default async function Page() {
  const response = await callFastAPI<{ data: unknown }>("/me");
  const account = decodeAuthenticatedAccount(response.data);
  const localDate = formatLocalDateInTimeZone(
    new Date(),
    account.calendarTimeZone,
  );
  redirect(`/daily/${localDate}`);
}
