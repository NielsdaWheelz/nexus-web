import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/client";
import type { PaneResourceLocator } from "@/lib/panes/paneResourceLocator";
import {
  resolveResourceLocator,
  resolveResourceLocators,
} from "./resourceLocators";

const PAGE_A = "11111111-1111-4111-8111-111111111111";
const PAGE_B = "22222222-2222-4222-8222-222222222222";

function locator(id: string): PaneResourceLocator {
  return { kind: "resource_ref", ref: `page:${id}` };
}

function resourceItem(id: string, missing = false) {
  const ref = `page:${id}`;
  const route = missing ? null : `/pages/${id}`;
  return {
    ref,
    scheme: "page",
    id,
    label: missing ? "(resource unavailable)" : `Page ${id}`,
    summary: "",
    route,
    activation: {
      resourceRef: ref,
      kind: missing ? "none" : "route",
      href: route,
      unresolvedReason: missing ? "missing" : null,
    },
    missing,
    capabilities: {
      userRelation: {
        userLinkSource: false,
        userLinkTarget: "none",
        noteReferenceTarget: false,
      },
      sharing: "None",
      libraryPlacement: "None",
      attachable: false,
      chatSubject: "none",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "none",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: true,
      adjacencyTarget: true,
    },
    versionByLane: {},
  };
}

function resolution(id: string, missing = false) {
  const item = resourceItem(id, missing);
  return {
    locator: locator(id),
    resourceItem: item,
    canonicalHref: item.route,
  };
}

function installResponse(resolutions: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ data: { resolutions } })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("resource locator transport identity", () => {
  it("retains ordered duplicate and missing resolutions one-for-one", async () => {
    installResponse([
      resolution(PAGE_A),
      resolution(PAGE_A),
      resolution(PAGE_B, true),
    ]);

    await expect(
      resolveResourceLocators([
        locator(PAGE_A),
        locator(PAGE_A),
        locator(PAGE_B),
      ]),
    ).resolves.toEqual([
      resolution(PAGE_A),
      resolution(PAGE_A),
      resolution(PAGE_B, true),
    ]);
  });

  it.each([
    {
      label: "short response",
      rows: [resolution(PAGE_A)],
    },
    {
      label: "reordered response",
      rows: [resolution(PAGE_B), resolution(PAGE_A)],
    },
    {
      label: "mismatched canonical href",
      rows: [
        resolution(PAGE_A),
        { ...resolution(PAGE_B), canonicalHref: `/pages/${PAGE_A}` },
      ],
    },
    {
      label: "malformed echoed locator",
      rows: [
        resolution(PAGE_A),
        {
          ...resolution(PAGE_B),
          locator: { ...locator(PAGE_B), extra: true },
        },
      ],
    },
  ])("defects on a $label", async ({ rows }) => {
    installResponse(rows);

    await expect(
      resolveResourceLocators([locator(PAGE_A), locator(PAGE_B)]),
    ).rejects.toMatchObject<ApiError>({ code: "E_INVALID_RESPONSE" });
  });

  it("requires the singleton response to match its requested locator", async () => {
    installResponse([resolution(PAGE_B)]);

    await expect(resolveResourceLocator(locator(PAGE_A))).rejects.toMatchObject<
      ApiError
    >({ code: "E_INVALID_RESPONSE" });
  });
});
