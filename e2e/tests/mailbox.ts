import { expect, type APIRequestContext } from "@playwright/test";

const MAILBOX_BASE_URL = process.env.E2E_MAILBOX_URL;

if (!MAILBOX_BASE_URL) {
  throw new Error("E2E_MAILBOX_URL must be provided by with_supabase_services.sh");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(value: unknown, keys: string[]): string | null {
  const obj = objectValue(value);
  if (!obj) return null;
  for (const key of keys) {
    const field = obj[key];
    if (typeof field === "string" && field) return field;
  }
  return null;
}

function messageList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const obj = objectValue(value);
  const candidates = [obj?.messages, obj?.Messages, obj?.data, obj?.items];
  return candidates.find((candidate): candidate is unknown[] =>
    Array.isArray(candidate)
  ) ?? [];
}

function messageBody(value: unknown): string {
  const direct = stringField(value, [
    "Text",
    "HTML",
    "text",
    "html",
    "Body",
    "body",
    "Raw",
    "raw",
  ]);
  if (direct) return direct;

  const nested = objectValue(objectValue(value)?.body);
  if (nested) {
    return (
      stringField(nested, ["Text", "HTML", "text", "html", "plain", "Raw"]) ??
      JSON.stringify(value)
    );
  }

  return JSON.stringify(value);
}

async function fetchJsonOrNull(
  request: APIRequestContext,
  url: string
): Promise<unknown | null> {
  const response = await request.get(url);
  return response.ok() ? response.json() : null;
}

async function latestMailpitBody(
  request: APIRequestContext,
  email: string
): Promise<string | null> {
  const searchUrl = new URL("/api/v1/search", MAILBOX_BASE_URL);
  searchUrl.searchParams.set("query", `to:${email}`);
  searchUrl.searchParams.set("limit", "10");
  const [message] = messageList(await fetchJsonOrNull(request, searchUrl.toString()));
  const id = stringField(message, ["ID", "Id", "id"]);
  if (!id) return null;
  const detail = await fetchJsonOrNull(
    request,
    new URL(`/api/v1/message/${encodeURIComponent(id)}`, MAILBOX_BASE_URL).toString()
  );
  return detail ? messageBody(detail) : null;
}

async function latestInbucketBody(
  request: APIRequestContext,
  email: string
): Promise<string | null> {
  const mailbox = email.split("@")[0] ?? email;
  const [message] = messageList(
    await fetchJsonOrNull(
      request,
      new URL(`/api/v1/mailbox/${encodeURIComponent(mailbox)}`, MAILBOX_BASE_URL).toString()
    )
  );
  const id = stringField(message, ["id", "ID", "Id"]);
  if (!id) return null;
  const detail = await fetchJsonOrNull(
    request,
    new URL(
      `/api/v1/mailbox/${encodeURIComponent(mailbox)}/${encodeURIComponent(id)}`,
      MAILBOX_BASE_URL
    ).toString()
  );
  return detail ? messageBody(detail) : null;
}

function extractFirstConfirmationLink(body: string): string {
  const normalized = body.replaceAll("&amp;", "&");
  const urls = normalized.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const link = urls
    .map((url) => url.replace(/[),.;]+$/, ""))
    .find(
      (url) =>
        url.includes("/auth/v1/verify") ||
        url.includes("token_hash=") ||
        url.includes("/auth/callback")
    );
  if (!link) {
    throw new Error(`Email confirmation link not found in message body: ${body}`);
  }
  return link;
}

export function expectAuthCallbackTarget(
  confirmationLink: string,
  appOrigin: string,
  nextPath: string
) {
  const confirmationUrl = new URL(confirmationLink);
  const redirectTo = confirmationUrl.searchParams.get("redirect_to");
  const callbackUrl = new URL(redirectTo ?? confirmationLink);

  expect(callbackUrl.origin).toBe(appOrigin);
  expect(callbackUrl.pathname).toBe("/auth/callback");
  expect(callbackUrl.searchParams.get("next")).toBe(nextPath);
}

export async function waitForEmailChangeConfirmationLink(
  request: APIRequestContext,
  email: string
): Promise<string> {
  let body: string | null = null;
  await expect
    .poll(
      async () => {
        body =
          (await latestMailpitBody(request, email)) ??
          (await latestInbucketBody(request, email));
        return body !== null;
      },
      {
        timeout: 20_000,
        message: `email-change confirmation email for ${email}`,
      }
    )
    .toBe(true);
  return extractFirstConfirmationLink(body ?? "");
}
