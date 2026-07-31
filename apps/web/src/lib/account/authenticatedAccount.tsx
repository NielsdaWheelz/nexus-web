"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AuthenticatedAccount } from "@/lib/account/contract";

export type { AuthenticatedAccount } from "@/lib/account/contract";

interface AuthenticatedAccountContextValue extends AuthenticatedAccount {
  setCalendarTimeZone: (timeZone: string) => void;
}

const AuthenticatedAccountContext =
  createContext<AuthenticatedAccountContextValue | null>(null);

export function AuthenticatedAccountProvider({
  account,
  children,
}: {
  account: AuthenticatedAccount;
  children: ReactNode;
}) {
  const [calendarTimeZone, setStoredCalendarTimeZone] = useState(
    account.calendarTimeZone,
  );
  const setCalendarTimeZone = useCallback((timeZone: string) => {
    if (timeZone.length === 0) {
      throw new TypeError("calendar time zone must not be empty");
    }
    setStoredCalendarTimeZone(timeZone);
  }, []);
  const value = useMemo(
    () => ({
      accountId: account.accountId,
      calendarTimeZone,
      setCalendarTimeZone,
    }),
    [account.accountId, calendarTimeZone, setCalendarTimeZone],
  );
  return (
    <AuthenticatedAccountContext.Provider value={value}>
      {children}
    </AuthenticatedAccountContext.Provider>
  );
}

export function useAuthenticatedAccount(): AuthenticatedAccountContextValue {
  const account = useContext(AuthenticatedAccountContext);
  if (account === null) {
    throw new Error(
      "useAuthenticatedAccount must be used inside AuthenticatedAccountProvider",
    );
  }
  return account;
}

export function useOptionalAuthenticatedAccount(): AuthenticatedAccountContextValue | null {
  return useContext(AuthenticatedAccountContext);
}
