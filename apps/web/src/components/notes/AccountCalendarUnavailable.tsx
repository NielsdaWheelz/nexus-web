"use client";

import { Fact } from "@/components/feedback/Fact";
import { ACCOUNT_DAY_UNAVAILABLE } from "@/lib/notes/accountDay";
import { getDestination } from "@/lib/navigation/destinations";

/** An unavailable day never borrows another zone; account settings can replace it. */
export default function AccountCalendarUnavailable() {
  const account = getDestination("account");
  return <Fact line={{ fact: ACCOUNT_DAY_UNAVAILABLE }} verbs={[{ label: account.label, href: account.href }]} />;
}
