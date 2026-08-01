import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublicShareReader from "./PublicShareReader";

const TOKEN = `nxshr1_${"A".repeat(43)}`;
const OPENING = `nxps1_${"B".repeat(48)}`;
const LOOMINGS = `nxps1_${"C".repeat(48)}`;
const KNOWN_PROSE =
  "Call me Ishmael. Some years ago—never mind how long precisely.";

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installPublicBff() {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request?.url ?? String(input), window.location.origin);
      const headers = new Headers(init?.headers ?? request?.headers);
      if (headers.get("X-Nexus-Share-Token") !== TOKEN) {
        throw new Error(`Public request omitted its exact share capability: ${url.pathname}`);
      }
      if (url.pathname === "/api/public/resource-share") {
        return json({
          version: "V1",
          subject: { kind: "Media" },
          media: {
            title: "Moby Dick; Or, The Whale",
            media_kind: "Epub",
            source_url: { kind: "Absent" },
            bylines: ["Herman Melville"],
          },
          reader: { kind: "Epub" },
        });
      }
      if (url.pathname === "/api/public/resource-share/navigation") {
        return json({
          kind: "EpubNavigation",
          items: [
            { ordinal: 0, label: "Title Page", depth: 0, section_handle: OPENING },
            {
              ordinal: 1,
              label: "CHAPTER 1. Loomings.",
              depth: 0,
              section_handle: LOOMINGS,
            },
          ],
          page_info: { next_cursor: { kind: "Absent" } },
        });
      }
      if (url.pathname === `/api/public/resource-share/sections/${OPENING}`) {
        return json({
          kind: "EpubSection",
          ordinal: 0,
          section_handle: OPENING,
          html_sanitized: "<h1>Title Page</h1><p>A book about a white whale.</p>",
          canonical_text: "Title Page A book about a white whale.",
        });
      }
      if (url.pathname === `/api/public/resource-share/sections/${LOOMINGS}`) {
        return json({
          kind: "EpubSection",
          ordinal: 1,
          section_handle: LOOMINGS,
          html_sanitized: `<h1>CHAPTER 1. Loomings.</h1><p>${KNOWN_PROSE}</p>`,
          canonical_text: `CHAPTER 1. Loomings. ${KNOWN_PROSE}`,
        });
      }
      throw new Error(`Unexpected public BFF request: ${url.pathname}${url.search}`);
    },
  );
}

describe("PublicShareReader EPUB composition", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", `/s#share=${TOKEN}`);
    installPublicBff();
  });

  it("uses the public TOC to reveal independently known prose from another section", async () => {
    render(<PublicShareReader />);

    expect(
      await screen.findByRole("heading", { name: "Moby Dick; Or, The Whale" }),
    ).toBeVisible();
    expect(await screen.findByText("A book about a white whale.")).toBeVisible();
    expect(screen.queryByText(KNOWN_PROSE)).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "CHAPTER 1. Loomings." }),
    );

    expect(await screen.findByText(KNOWN_PROSE)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "CHAPTER 1. Loomings." }),
    ).toHaveAttribute("aria-current", "location");
  });
});
