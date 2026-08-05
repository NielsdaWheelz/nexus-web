import { asRecord, exactKeys } from "@/lib/api/exact";
import type {
  EmailConfirmationOutcome,
  EmailLinkKind,
} from "@/lib/auth/email-confirmation";
import type {
  PasswordRecoveryOutcome,
  PasswordSignInOutcome,
  PasswordUpdateOutcome,
} from "@/lib/auth/password-flow";

function decodeKindOnly<const Kind extends string>(
  record: Record<string, unknown>,
  kind: Kind,
  context: string,
): { kind: Kind } {
  exactKeys(record, ["kind"], context);
  return { kind };
}

function unexpectedKind(context: string): never {
  // justify-defect: these responses come from same-release Nexus handlers;
  // malformed or widened JSON means the two sides of our wire contract drifted.
  throw new TypeError(`${context} has an unknown kind`);
}

export function decodePasswordSignInOutcome(
  raw: unknown,
): PasswordSignInOutcome {
  const record = asRecord(raw, "password sign-in outcome");
  switch (record.kind) {
    case "SignedIn":
      return decodeKindOnly(record, "SignedIn", "SignedIn outcome");
    case "InvalidCredentials":
      return decodeKindOnly(
        record,
        "InvalidCredentials",
        "InvalidCredentials outcome",
      );
    case "RateLimited":
      return decodeKindOnly(record, "RateLimited", "RateLimited outcome");
    case "ServiceUnavailable":
      return decodeKindOnly(
        record,
        "ServiceUnavailable",
        "ServiceUnavailable outcome",
      );
    default:
      return unexpectedKind("password sign-in outcome");
  }
}

export function decodePasswordRecoveryOutcome(
  raw: unknown,
): PasswordRecoveryOutcome {
  const record = asRecord(raw, "password recovery outcome");
  switch (record.kind) {
    case "Requested":
      return decodeKindOnly(record, "Requested", "Requested outcome");
    case "RateLimited":
      return decodeKindOnly(record, "RateLimited", "RateLimited outcome");
    case "ServiceUnavailable":
      return decodeKindOnly(
        record,
        "ServiceUnavailable",
        "ServiceUnavailable outcome",
      );
    default:
      return unexpectedKind("password recovery outcome");
  }
}

export function decodePasswordUpdateOutcome(
  raw: unknown,
): PasswordUpdateOutcome {
  const record = asRecord(raw, "password update outcome");
  switch (record.kind) {
    case "Saved":
      return decodeKindOnly(record, "Saved", "Saved outcome");
    case "PolicyRejected": {
      exactKeys(record, ["kind", "reasons"], "PolicyRejected outcome");
      if (
        !Array.isArray(record.reasons) ||
        record.reasons.length !== 1 ||
        record.reasons[0] !== "length"
      ) {
        throw new TypeError(
          "PolicyRejected outcome must contain the configured length reason",
        );
      }
      return { kind: "PolicyRejected", reasons: ["length"] };
    }
    case "SessionEnded":
      return decodeKindOnly(record, "SessionEnded", "SessionEnded outcome");
    case "RateLimited":
      return decodeKindOnly(record, "RateLimited", "RateLimited outcome");
    case "ServiceUnavailable":
      return decodeKindOnly(
        record,
        "ServiceUnavailable",
        "ServiceUnavailable outcome",
      );
    default:
      return unexpectedKind("password update outcome");
  }
}

export function decodeEmailConfirmationOutcome(
  raw: unknown,
  expectedPurpose: EmailLinkKind,
): EmailConfirmationOutcome {
  const record = asRecord(raw, "email confirmation outcome");
  switch (record.kind) {
    case "Confirmed":
      exactKeys(record, ["kind", "purpose"], "Confirmed outcome");
      if (record.purpose !== expectedPurpose) {
        throw new TypeError(
          "Confirmed outcome purpose does not match the submitted link",
        );
      }
      return { kind: "Confirmed", purpose: expectedPurpose };
    case "InvalidOrExpired":
      return decodeKindOnly(
        record,
        "InvalidOrExpired",
        "InvalidOrExpired outcome",
      );
    case "RateLimited":
      return decodeKindOnly(record, "RateLimited", "RateLimited outcome");
    case "ServiceUnavailable":
      return decodeKindOnly(
        record,
        "ServiceUnavailable",
        "ServiceUnavailable outcome",
      );
    default:
      return unexpectedKind("email confirmation outcome");
  }
}
