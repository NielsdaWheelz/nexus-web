import {
  expectExactRecord,
  expectNullableString,
  expectString,
} from "@/lib/validation";

export interface AuthenticatedAccount {
  accountId: string;
  calendarTimeZone: string;
}

export interface AuthenticatedAccountProfile extends AuthenticatedAccount {
  defaultLibraryId: string;
  email: string | null;
  displayName: string | null;
  emailIngestAddress: string | null;
}

export class AuthenticatedAccountContractDefect extends TypeError {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticatedAccountContractDefect";
  }
}

export function isAuthenticatedAccountContractDefect(
  error: unknown,
): error is AuthenticatedAccountContractDefect {
  return error instanceof AuthenticatedAccountContractDefect;
}

export function decodeAuthenticatedAccountProfile(
  raw: unknown,
): AuthenticatedAccountProfile {
  try {
    const account = expectExactRecord(
      raw,
      [
        "user_id",
        "default_library_id",
        "email",
        "display_name",
        "calendar_time_zone",
        "email_ingest_address",
      ],
      "authenticated account",
    );
    return {
      accountId: expectString(
        account.user_id,
        "authenticated account.user_id",
      ),
      defaultLibraryId: expectString(
        account.default_library_id,
        "authenticated account.default_library_id",
      ),
      email: expectNullableString(
        account.email,
        "authenticated account.email",
      ),
      displayName: expectNullableString(
        account.display_name,
        "authenticated account.display_name",
      ),
      calendarTimeZone: expectString(
        account.calendar_time_zone,
        "authenticated account.calendar_time_zone",
      ),
      emailIngestAddress: expectNullableString(
        account.email_ingest_address,
        "authenticated account.email_ingest_address",
      ),
    };
  } catch (error) {
    if (isAuthenticatedAccountContractDefect(error)) throw error;
    throw new AuthenticatedAccountContractDefect(
      error instanceof Error
        ? error.message
        : "authenticated account response was invalid",
    );
  }
}

export function decodeAuthenticatedAccount(raw: unknown): AuthenticatedAccount {
  const account = decodeAuthenticatedAccountProfile(raw);
  return {
    accountId: account.accountId,
    calendarTimeZone: account.calendarTimeZone,
  };
}
