"use client";

import {createContext, useContext, useEffect, useState, type ReactNode} from "react";
import {useAuthenticatedAccount} from "@/lib/account/authenticatedAccount";
import {formatLocalDateInTimeZone} from "@/lib/localDate";

export const ACCOUNT_DAY_UNAVAILABLE = "this browser cannot read your calendar time zone.";

const AccountDay = createContext<{ today: string | null } | null>(null);

/** One account calendar clock; timers change presentation, never authored state. */
export function AccountDayProvider({children}: {children: ReactNode}) {
  const {calendarTimeZone} = useAuthenticatedAccount();
  const [current, setCurrent] = useState(() => ({zone:calendarTimeZone,date:formatLocalDateInTimeZone(new Date(),calendarTimeZone)}));
  const today = current.zone === calendarTimeZone ? current.date : formatLocalDateInTimeZone(new Date(),calendarTimeZone);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const now = Date.now(), date = formatLocalDateInTimeZone(new Date(now),calendarTimeZone);
      setCurrent(previous => previous.zone === calendarTimeZone && previous.date === date ? previous : {zone:calendarTimeZone,date});
      if (date === null) return;
      // Find the next civil-day boundary, including 23/25-hour days, to one second.
      let left = now, right = now + 27 * 60 * 60 * 1000;
      while (right - left > 1000) {
        const middle = Math.floor((left + right) / 2);
        if (formatLocalDateInTimeZone(new Date(middle),calendarTimeZone) === date) left = middle;
        else right = middle;
      }
      timer = setTimeout(update, right - now);
    };
    const visible = () => {if (document.visibilityState === "visible") update();};
    update(); window.addEventListener("focus", update); document.addEventListener("visibilitychange",visible);
    return () => {clearTimeout(timer); window.removeEventListener("focus",update); document.removeEventListener("visibilitychange",visible);};
  }, [calendarTimeZone]);
  return <AccountDay value={{ today }}>{children}</AccountDay>;
}

export function useAccountToday(): string | null {
  const calendar = useContext(AccountDay);
  if (calendar === null) throw new Error("account day owner is missing");
  return calendar.today;
}
