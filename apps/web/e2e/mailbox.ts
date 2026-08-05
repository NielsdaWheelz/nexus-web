import { expect } from "playwright/test";
import type { ExactOriginRequest } from "./request";

type AuthEmailKind = "invite" | "recovery";

interface MailpitAddress {
  Address: string;
  Name: string;
}

interface MailpitMessageSummary {
  ID: string;
  To: MailpitAddress[];
}

function mailpitAddress(value: unknown): MailpitAddress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Mailpit address must be an object.");
  }
  const address = value as Record<string, unknown>;
  if (typeof address.Address !== "string" || typeof address.Name !== "string") {
    throw new Error("Mailpit address has an invalid shape.");
  }
  return { Address: address.Address, Name: address.Name };
}

function mailpitAddresses(value: unknown): MailpitAddress[] {
  if (!Array.isArray(value)) {
    throw new Error("Mailpit recipients must be an array.");
  }
  return value.map(mailpitAddress);
}

function mailpitSearchResults(
  value: unknown,
  email: string,
): MailpitMessageSummary[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Mailpit search response must be an object.");
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.messages)) {
    throw new Error("Mailpit search response must contain a messages array.");
  }
  return response.messages.flatMap((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error("Mailpit message summary must be an object.");
    }
    const message = item as Record<string, unknown>;
    const recipients = mailpitAddresses(message.To);
    if (typeof message.ID !== "string" || !message.ID) {
      throw new Error("Mailpit message summary has an invalid identity.");
    }
    return recipients.some(({ Address }) => Address === email)
      ? [{ ID: message.ID, To: recipients }]
      : [];
  });
}

function mailpitMessageBody(
  value: unknown,
  message: MailpitMessageSummary,
  email: string,
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Mailpit message response must be an object.");
  }
  const detail = value as Record<string, unknown>;
  const recipients = mailpitAddresses(detail.To);
  if (
    detail.ID !== message.ID ||
    typeof detail.Text !== "string" ||
    typeof detail.HTML !== "string"
  ) {
    throw new Error("Mailpit message identity or body shape is invalid.");
  }
  if (!recipients.some(({ Address }) => Address === email)) return null;
  return `${detail.Text}\n${detail.HTML}`;
}

function capturedAuthLink(
  body: string,
  kind: AuthEmailKind,
  appOrigin: string,
): URL | null {
  const expectedPath = kind === "invite" ? "/auth/invite" : "/auth/recovery";
  const rawLinks =
    body.replaceAll("&amp;", "&").match(/https?:\/\/[^\s"'<>]+/g) ?? [];
  const links = new Map<string, URL>();
  for (const raw of rawLinks) {
    const candidate = new URL(raw.replace(/[),.;]+$/, ""));
    const keys = [...candidate.searchParams.keys()];
    if (
      candidate.origin === appOrigin &&
      candidate.pathname === expectedPath &&
      !candidate.username &&
      !candidate.password &&
      !candidate.hash &&
      keys.length === 1 &&
      keys[0] === "token_hash" &&
      candidate.searchParams.get("token_hash")
    ) {
      links.set(candidate.toString(), candidate);
    }
  }
  if (links.size > 1) {
    throw new Error(
      `Captured ${kind} email contains multiple valid auth links.`,
    );
  }
  return links.values().next().value ?? null;
}

async function latestCapturedAuthLink(
  request: ExactOriginRequest,
  email: string,
  kind: AuthEmailKind,
  appOrigin: string,
): Promise<URL | null> {
  const search = new URL("/api/v1/search", request.origin);
  search.searchParams.set("query", `to:${email}`);
  search.searchParams.set("limit", "10");
  const listed = await request.get(search.toString());
  if (!listed.ok()) {
    throw new Error(`Mailpit search failed with status ${listed.status()}.`);
  }
  const messages = mailpitSearchResults(await listed.json(), email);
  const links = new Map<string, URL>();
  for (const message of messages) {
    const response = await request.get(
      `/api/v1/message/${encodeURIComponent(message.ID)}`,
    );
    if (response.status() === 404) continue;
    if (!response.ok()) {
      throw new Error(
        `Mailpit message lookup failed with status ${response.status()}.`,
      );
    }
    const body = mailpitMessageBody(await response.json(), message, email);
    if (body) {
      const link = capturedAuthLink(body, kind, appOrigin);
      if (link) links.set(link.toString(), link);
    }
  }
  if (links.size > 1) {
    throw new Error(`Mailpit contains multiple captured ${kind} auth links.`);
  }
  return links.values().next().value ?? null;
}

export async function waitForCapturedAuthLink(
  request: ExactOriginRequest,
  email: string,
  kind: AuthEmailKind,
  appOrigin: string,
): Promise<URL> {
  let link: URL | null = null;
  await expect
    .poll(
      async () => {
        link = await latestCapturedAuthLink(request, email, kind, appOrigin);
        return link !== null;
      },
      {
        timeout: 20_000,
        message: `captured ${kind} email for ${email}`,
      },
    )
    .toBe(true);
  if (!link)
    throw new Error(`Captured ${kind} email did not expose one auth link.`);
  return link;
}
