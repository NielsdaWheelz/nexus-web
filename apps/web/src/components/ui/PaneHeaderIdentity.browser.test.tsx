/**
 * Risk: pane chrome is the sole owner of app-generated route identity
 * (`docs/cutovers/canonical-pane-title-ownership-hard-cutover.md`). If the
 * identity projection loses the single route-level `<h1>`, truncates the stored
 * title, announces async identity through a live region, or lets a long/RTL
 * title push the fixed pane controls, the user loses the only exact name a pane
 * has — and, at 320/390px, in a narrow split, or at 200% text scale, loses the
 * controls too.
 *
 * The system under test is the identity projection exactly as the user meets
 * it: the real `SurfaceHeader` (which composes `PaneHeaderIdentity`) for desktop
 * chrome, and the real `PaneHeaderIdentity` for the mobile credit cap. Models
 * are built by the production `resolvePaneHeaderModel` fed by the production
 * pane-route registry, so the route contract → resolver → projection path runs
 * end to end. Expected titles, support copy, credit caps, and typography tokens
 * come from the specification, never from the implementation's output.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import "@/app/globals.css";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import {
  resolvePaneHeaderModel,
  type PaneHeaderCreditGroup,
  type PaneHeaderModel,
  type PaneHeaderPublication,
} from "@/lib/panes/paneHeaderModel";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import PaneHeaderIdentity from "./PaneHeaderIdentity";
import SurfaceHeader from "./SurfaceHeader";

const PRIMARY_IDENTITY_ID = "pane-a-identity";
const LEFT_IDENTITY_ID = "pane-left-identity";
const RIGHT_IDENTITY_ID = "pane-right-identity";

/**
 * A viewport resize is settled when the document is no wider than the viewport
 * and no narrower than one classic Chromium scrollbar. A symmetric tolerance
 * would let "320px" silently mean 340px.
 */
const SCROLLBAR_ALLOWANCE_PX = 17;
const INITIAL_VIEWPORT = {
  width: window.innerWidth,
  height: window.innerHeight,
};

/**
 * Spec: "`Count` and `Date` retain the existing locale formatting" — a date-only
 * ISO parsed as a LOCAL date and rendered short weekday + day + month. The
 * oracle is the literal en-US rendering of that contract: 2026-06-03 is a
 * Wednesday, so short weekday/day/month reads "Wed, Jun 3".
 */
const SUPPORT_DATE_ISO = "2026-06-03";
const EXPECTED_SHORT_DATE = "Wed, Jun 3";

/**
 * Three credits across two groups, so the Desktop cap of two spans both groups:
 * the `Authors` group is named only for assistive technology, the `Role` group
 * carries a visible "Translator: " prefix, and its leading credit is
 * unresolved — a credit without an href is plain text, never a link.
 */
const SOLARIS_CREDIT_GROUPS: readonly PaneHeaderCreditGroup[] = [
  {
    kind: "Authors",
    credits: [{ label: "Stanisław Lem", href: "/authors/stanislaw-lem" }],
  },
  {
    kind: "Role",
    label: "Translator",
    credits: [
      { label: "Bill Johnston" },
      { label: "Steve Cox", href: "/authors/steve-cox" },
    ],
  },
];

const SHORT_TITLE = "Deep Work";
/** No breaking opportunity anywhere: the projection cannot wrap its way out. */
const LONG_LTR_TITLE =
  "Antidisestablishmentarianismandthecounterreformationofnineteenthcenturytransatlanticpublishinghouses, Volume Two";
const LONG_RTL_TITLE =
  "מסע אל קצה הלילה: מחשבות על ספרות, זיכרון וההיסטוריה של ההוצאה לאור העברית בראשית המאה העשרים";

const TEXT_SCALES = [
  { name: "100% text scale", rootFontSize: "16px" },
  { name: "200% text scale", rootFontSize: "32px" },
] as const;

const NARROW_VIEWPORT_WIDTHS = [320, 390] as const;
const FIXED_CONTROLS = [
  { key: "back", accessibleName: "Go back in this pane" },
  { key: "forward", accessibleName: "Go forward in this pane" },
  { key: "options", accessibleName: "Options" },
] as const;

/** Spec: "async replacement is not an `aria-live` announcement". */
const LIVE_REGION_SELECTOR =
  '[aria-live],[role="status"],[role="alert"],[role="log"],[role="marquee"],[role="timer"]';

const SUPPORT_LINE_SELECTOR = '[data-pane-header-support="true"]';

/** The pane landmark PaneShell wraps around this chrome in production. */
const PANE_REGION_LABEL = "Pane chrome";

const PANE_OPTIONS: readonly ActionDescriptor[] = [
  {
    kind: "command",
    id: "Pane.Close",
    label: "Close pane",
    onSelect: () => {},
  },
];

const PANE_NAVIGATION = {
  canGoBack: true,
  canGoForward: true,
  onBack: () => {},
  onForward: () => {},
};

function raise(message: string): never {
  throw new Error(message);
}

function normalizeText(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function elementsMatching(
  root: ParentNode,
  selector: string,
): readonly HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector));
}

function describeElement(element: HTMLElement): string {
  return element.outerHTML.slice(0, 200);
}

interface HeaderModelInput {
  readonly href: string;
  readonly label: string;
  readonly labelPending?: boolean;
  readonly publication?: PaneHeaderPublication;
}

/**
 * Resolve a header model through the production route registry and the
 * production resolver, so the projection receives precisely what the pane
 * runtime hands it: the route's header contract, the canonical pane label, and
 * an accepted same-route-key publication.
 */
function headerModel({
  href,
  label,
  labelPending = false,
  publication,
}: HeaderModelInput): PaneHeaderModel {
  const route = resolvePaneRouteModel(href);
  const routeHeader =
    route.header ??
    raise(
      `Pane route fixture "${href}" resolved to route "${route.id}", which declares no header contract.`,
    );
  const routeKey = `${route.id}:${href}`;
  return resolvePaneHeaderModel({
    currentRouteKey: routeKey,
    routeHeader,
    paneLabel: label,
    paneLabelPending: labelPending,
    publication: publication ? { routeKey, header: publication } : null,
  });
}

function sectionCount(value: number, unit: string): PaneHeaderPublication {
  return { kind: "Section", meta: { kind: "Count", value, unit } };
}

function libraryDetailModel(title: string): PaneHeaderModel {
  return headerModel({
    href: "/libraries/lib-1",
    label: title,
    publication: sectionCount(12, "item"),
  });
}

function desktopHeader(model: PaneHeaderModel) {
  return withRenderEnvironment(
    <section aria-label={PANE_REGION_LABEL}>
      <SurfaceHeader
        header={model}
        identityId={PRIMARY_IDENTITY_ID}
        options={PANE_OPTIONS}
        navigation={PANE_NAVIGATION}
      />
    </section>,
  );
}

/**
 * The identity projection's own DOM contract (design §2.1): one
 * `[data-pane-header-identity]` root that carries `aria-busy`, one `<h1>`, and
 * at most one `[data-pane-header-support]` line. No accessible role or name
 * identifies either wrapper, so these reach them by their product attributes.
 */
function identityRootFor(heading: HTMLElement): HTMLElement {
  return (
    heading.closest<HTMLElement>('[data-pane-header-identity="true"]') ??
    raise(
      `The <h1> "${normalizeText(heading.textContent)}" is not inside a [data-pane-header-identity] root, so pending state and support content have no owner.`,
    )
  );
}

function supportLineFor(heading: HTMLElement): HTMLElement | null {
  const supportLines = elementsMatching(
    identityRootFor(heading),
    SUPPORT_LINE_SELECTOR,
  );
  if (supportLines.length > 1) {
    raise(
      `The identity projection beside "${normalizeText(heading.textContent)}" must render at most one support line; it rendered ${supportLines.length} (${supportLines
        .map((line) => `"${normalizeText(line.textContent)}"`)
        .join(", ")}).`,
    );
  }
  return supportLines[0] ?? null;
}

function supportTextFor(heading: HTMLElement): string | null {
  const support = supportLineFor(heading);
  return support ? normalizeText(support.textContent) : null;
}

function requireSupportLineFor(
  heading: HTMLElement,
  caseName: string,
): HTMLElement {
  return (
    supportLineFor(heading) ??
    raise(
      `${caseName}: expected a support line beside the <h1>, but the identity rendered the title alone.`,
    )
  );
}

/**
 * Async identity replacement must not be announced. `aria-live` on the identity
 * root itself — the very element that carries `aria-busy` — or on any ancestor
 * would announce it just as loudly as one nested inside, so this looks upward
 * from the heading and across the whole rendered document.
 */
function enclosingLiveRegion(heading: HTMLElement): HTMLElement | null {
  return heading.closest<HTMLElement>(LIVE_REGION_SELECTOR);
}

function expectNoLiveRegion(heading: HTMLElement, caseName: string): void {
  const enclosing = enclosingLiveRegion(heading);
  expect(
    enclosing === null ? null : describeElement(enclosing),
    `${caseName}: the identity must not sit inside a live region — async title replacement must not be announced.`,
  ).toBeNull();
  expect(
    elementsMatching(document.body, LIVE_REGION_SELECTOR).map(describeElement),
    `${caseName}: the identity projection must render no live region anywhere in the document.`,
  ).toEqual([]);
}

function titleTypography(heading: HTMLElement) {
  const computed = window.getComputedStyle(heading);
  return {
    fontSize: computed.fontSize,
    fontWeight: computed.fontWeight,
    color: computed.color,
    lineHeight: computed.lineHeight,
    textAlign: computed.textAlign,
  };
}

function controlBoxes(paneRegion: HTMLElement): Record<string, DOMRect> {
  const boxes: Record<string, DOMRect> = {};
  for (const control of FIXED_CONTROLS) {
    boxes[control.key] = within(paneRegion)
      .getByRole("button", { name: control.accessibleName })
      .getBoundingClientRect();
  }
  return boxes;
}

/**
 * The specification's narrow-viewport acceptance case: the title ellipsizes
 * inside its own column, stays whole in the DOM and the native disclosure, the
 * fixed control rail keeps its natural size and never meets the title, and
 * nothing escapes the viewport horizontally. The caller supplies the oracle —
 * the expected title, its expected writing direction, and the control sizes
 * measured at a wide viewport.
 */
function expectTruncatedIdentity({
  caseName,
  paneRegion,
  title,
  direction,
  baselineControls,
}: {
  readonly caseName: string;
  readonly paneRegion: HTMLElement;
  readonly title: string;
  readonly direction: "ltr" | "rtl";
  readonly baselineControls: Record<string, DOMRect>;
}): void {
  const heading = within(paneRegion).getByRole("heading", {
    level: 1,
    name: title,
  });
  const headingBox = heading.getBoundingClientRect();

  // (a) The title visibly truncates rather than growing the header.
  expect(
    heading.scrollWidth,
    `${caseName}: the title must ellipsize inside its column — scrollWidth ${heading.scrollWidth}px must exceed clientWidth ${heading.clientWidth}px.`,
  ).toBeGreaterThan(heading.clientWidth);

  // (b) Truncation is presentation only: the full text stays addressable, and
  //     `dir="auto"` resolves the title's own writing direction.
  expect(
    heading.textContent,
    `${caseName}: the untruncated title must remain the element's text content.`,
  ).toBe(title);
  expect(
    heading,
    `${caseName}: the untruncated title must remain in the native title disclosure.`,
  ).toHaveAttribute("title", title);
  expect(
    window.getComputedStyle(heading).direction,
    `${caseName}: the <h1> must resolve its own writing direction from the title text, so an RTL title reads right-to-left inside LTR chrome.`,
  ).toBe(direction);
  expect(
    within(paneRegion)
      .getAllByRole("heading", { level: 1, name: title })
      .map((match) => normalizeText(match.textContent)),
    `${caseName}: exactly one route-level <h1> must expose the full untruncated accessible name.`,
  ).toEqual([title]);

  // (c) Fixed chrome keeps its natural size and never meets the title.
  const controls = controlBoxes(paneRegion);
  for (const control of FIXED_CONTROLS) {
    const box = controls[control.key];
    const baseline = baselineControls[control.key];
    expect(
      box.width,
      `${caseName}: the "${control.accessibleName}" control must keep its natural width — baseline ${baseline.width}px at a wide viewport, measured ${box.width}px.`,
    ).toBeCloseTo(baseline.width, 0);
    expect(
      box.height,
      `${caseName}: the "${control.accessibleName}" control must keep its natural height — baseline ${baseline.height}px at a wide viewport, measured ${box.height}px.`,
    ).toBeCloseTo(baseline.height, 0);
    const overlapsTitle =
      box.left < headingBox.right && headingBox.left < box.right;
    expect(
      overlapsTitle,
      `${caseName}: the "${control.accessibleName}" control [${box.left}, ${box.right}] must not overlap the title [${headingBox.left}, ${headingBox.right}].`,
    ).toBe(false);
  }

  // (d) Nothing escapes the viewport horizontally.
  expect(
    document.documentElement.scrollWidth,
    `${caseName}: the document must not overflow horizontally — scrollWidth ${document.documentElement.scrollWidth}px vs clientWidth ${document.documentElement.clientWidth}px.`,
  ).toBeLessThanOrEqual(document.documentElement.clientWidth);
}

async function applyViewport(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await waitFor(() => {
    const clientWidth = document.documentElement.clientWidth;
    expect(
      clientWidth <= width && clientWidth >= width - SCROLLBAR_ALLOWANCE_PX,
      `Viewport resize to ${width}×${height} never settled: documentElement.clientWidth is ${clientWidth}px, which must be no wider than the ${width}px viewport and no more than one ${SCROLLBAR_ALLOWANCE_PX}px scrollbar narrower.`,
    ).toBe(true);
  });
}

describe("Pane header identity projection", () => {
  afterEach(async () => {
    document.documentElement.style.removeProperty("font-size");
    await page.viewport(INITIAL_VIEWPORT.width, INITIAL_VIEWPORT.height);
  });

  it("publishes one pane-scoped route-level h1 with the full exact title, its native disclosure, and the support line the route and publication resolve", () => {
    const cases = [
      {
        name: "Lectern index with a resolved count",
        title: "Lectern",
        support: "12 items",
        busy: false,
        model: headerModel({
          href: "/lectern",
          label: "Lectern",
          publication: sectionCount(12, "item"),
        }),
      },
      {
        name: "Library detail with a resolved count",
        title: "Deep Work & Attention",
        support: "Libraries · 12 items",
        busy: false,
        model: libraryDetailModel("Deep Work & Attention"),
      },
      {
        name: "Library detail with a date",
        title: "Deep Work & Attention",
        support: `Libraries · ${EXPECTED_SHORT_DATE}`,
        busy: false,
        model: headerModel({
          href: "/libraries/lib-1",
          label: "Deep Work & Attention",
          publication: {
            kind: "Section",
            meta: { kind: "Date", iso: SUPPORT_DATE_ISO },
          },
        }),
      },
      {
        name: "Settings child",
        title: "Account",
        support: "Settings",
        busy: false,
        model: headerModel({ href: "/settings/account", label: "Account" }),
      },
      {
        name: "Conversation",
        title: "Why Solaris resists interpretation",
        support: "Chats",
        busy: false,
        model: headerModel({
          href: "/conversations/c-1",
          label: "Why Solaris resists interpretation",
        }),
      },
      {
        name: "Lectern index with no publication",
        title: "Lectern",
        support: null,
        busy: false,
        model: headerModel({ href: "/lectern", label: "Lectern" }),
      },
      {
        name: "Lectern index with pending metadata",
        title: "Lectern",
        support: null,
        busy: true,
        model: headerModel({
          href: "/lectern",
          label: "Lectern",
          publication: { kind: "Section", meta: { kind: "Pending" } },
        }),
      },
      {
        name: "Lectern index whose canonical label is still resolving",
        title: "Lectern",
        support: null,
        busy: true,
        model: headerModel({
          href: "/lectern",
          label: "Lectern",
          labelPending: true,
        }),
      },
    ];

    const { rerender } = render(desktopHeader(cases[0].model));

    for (const scenario of cases) {
      rerender(desktopHeader(scenario.model));

      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(
        headings.map((heading) => normalizeText(heading.textContent)),
        `${scenario.name}: a pane projection must expose exactly one route-level <h1>; the document exposes ${headings.length}.`,
      ).toEqual([scenario.title]);

      const heading = screen.getByRole("heading", {
        level: 1,
        name: scenario.title,
      });
      expect(
        heading.textContent,
        `${scenario.name}: the <h1> must carry the full exact title in the DOM; expected "${scenario.title}", read "${heading.textContent}".`,
      ).toBe(scenario.title);
      expect(
        heading,
        `${scenario.name}: the full title must stay in the native title disclosure.`,
      ).toHaveAttribute("title", scenario.title);
      expect(
        heading,
        `${scenario.name}: the identity id must land on the <h1> itself, so split panes keep pane-scoped heading ids.`,
      ).toHaveAttribute("id", PRIMARY_IDENTITY_ID);

      const support = supportTextFor(heading);
      expect(
        support,
        scenario.support === null
          ? `${scenario.name}: with neither context nor metadata the identity must render no support line at all; it rendered "${support}".`
          : `${scenario.name}: expected the support line "${scenario.support}", read "${support}".`,
      ).toBe(scenario.support);

      const identity = identityRootFor(heading);
      if (scenario.busy) {
        expect(
          identity,
          `${scenario.name}: unresolved identity must be marked aria-busy rather than render a placeholder support line.`,
        ).toHaveAttribute("aria-busy", "true");
      } else {
        expect(
          identity.getAttribute("aria-busy"),
          `${scenario.name}: resolved identity must not stay busy.`,
        ).not.toBe("true");
      }
    }
  });

  it("keeps a non-empty h1 through every resource state, marks only pending identity aria-busy, and never announces the replacement in a live region", () => {
    const pendingModel = headerModel({ href: "/media/m-1", label: "Media" });
    const readyModel = headerModel({
      href: "/media/m-1",
      label: "Solaris",
      publication: {
        kind: "Resource",
        resource: { status: "Ready", creditGroups: SOLARIS_CREDIT_GROUPS },
      },
    });
    // A dossier is ready with no credits at all (ArtifactPaneBody publishes
    // exactly this): the identity owes the title alone, not an empty line.
    const creditlessReadyModel = headerModel({
      href: "/artifacts/a-1",
      label: "Attention and its discontents",
      publication: {
        kind: "Resource",
        resource: { status: "Ready", creditGroups: [] },
      },
    });
    const unavailableModel = headerModel({
      href: "/media/m-1",
      label: "Media",
      publication: { kind: "Resource", resource: { status: "Unavailable" } },
    });
    const failedModel = headerModel({
      href: "/media/m-1",
      label: "Media",
      publication: { kind: "Resource", resource: { status: "Failed" } },
    });

    const { rerender } = render(desktopHeader(pendingModel));

    // Pending: the non-empty route label is the title; the pending label is support.
    const pendingHeading = screen.getByRole("heading", {
      level: 1,
      name: "Media",
    });
    expect(
      pendingHeading.textContent,
      `Pending resource: the <h1> must carry the non-empty route label "Media", not a skeleton; it read "${pendingHeading.textContent}".`,
    ).toBe("Media");
    expect(
      supportTextFor(pendingHeading),
      "Pending resource: the route's pending label must be the support line.",
    ).toBe("Loading media…");
    expect(
      identityRootFor(pendingHeading),
      "Pending resource: unresolved identity must be marked aria-busy.",
    ).toHaveAttribute("aria-busy", "true");
    expectNoLiveRegion(pendingHeading, "Pending resource");

    // Ready: the exact resource title plus its credits.
    rerender(desktopHeader(readyModel));
    const readyHeading = screen.getByRole("heading", {
      level: 1,
      name: "Solaris",
    });
    expect(
      readyHeading.textContent,
      `Ready resource: the <h1> must carry the exact resource title; it read "${readyHeading.textContent}".`,
    ).toBe("Solaris");
    const readySupport = requireSupportLineFor(readyHeading, "Ready resource");
    expect(
      within(readySupport)
        .getAllByRole("link")
        .map((link) => normalizeText(link.textContent)),
      `Ready resource: the support line must project the resource credits; it read "${normalizeText(readySupport.textContent)}".`,
    ).toContain("Stanisław Lem");
    expect(
      identityRootFor(readyHeading).getAttribute("aria-busy"),
      "Ready resource: resolved identity must not stay busy.",
    ).not.toBe("true");
    expectNoLiveRegion(readyHeading, "Ready resource");

    // Ready with no credits: the title stands alone; no reserved empty line.
    rerender(desktopHeader(creditlessReadyModel));
    const creditlessHeading = screen.getByRole("heading", {
      level: 1,
      name: "Attention and its discontents",
    });
    expect(
      supportTextFor(creditlessHeading),
      "Ready resource without credits: a resource that credits nobody must render no support line at all, not a blank placeholder.",
    ).toBeNull();
    expect(
      identityRootFor(creditlessHeading).getAttribute("aria-busy"),
      "Ready resource without credits: a ready resource is resolved, not busy.",
    ).not.toBe("true");
    expectNoLiveRegion(creditlessHeading, "Ready resource without credits");

    // Unavailable: the route label survives; status is support copy.
    rerender(desktopHeader(unavailableModel));
    const unavailableHeading = screen.getByRole("heading", {
      level: 1,
      name: "Media",
    });
    expect(
      unavailableHeading.textContent,
      `Unavailable resource: the <h1> must keep the non-empty route label; it read "${unavailableHeading.textContent}".`,
    ).toBe("Media");
    expect(
      supportTextFor(unavailableHeading),
      "Unavailable resource: the status must be the support line, never the title.",
    ).toBe("Unavailable");
    expect(
      identityRootFor(unavailableHeading).getAttribute("aria-busy"),
      "Unavailable resource: a terminal state is resolved, not busy.",
    ).not.toBe("true");
    expectNoLiveRegion(unavailableHeading, "Unavailable resource");

    // Failed: the route label survives; failure is support copy.
    rerender(desktopHeader(failedModel));
    const failedHeading = screen.getByRole("heading", {
      level: 1,
      name: "Media",
    });
    expect(
      failedHeading.textContent,
      `Failed resource: the <h1> must keep the non-empty route label; it read "${failedHeading.textContent}".`,
    ).toBe("Media");
    expect(
      supportTextFor(failedHeading),
      "Failed resource: the failure copy must be the support line, never the title.",
    ).toBe("Failed to load");
    expect(
      identityRootFor(failedHeading).getAttribute("aria-busy"),
      "Failed resource: a terminal state is resolved, not busy.",
    ).not.toBe("true");
    expectNoLiveRegion(failedHeading, "Failed resource");
  });

  it("caps ready credits at two on Desktop and one on Mobile, names Authors for assistive technology, shows the Role label, links only resolved credits, and counts the hidden remainder", () => {
    const model = headerModel({
      href: "/media/m-1",
      label: "Solaris",
      publication: {
        kind: "Resource",
        resource: { status: "Ready", creditGroups: SOLARIS_CREDIT_GROUPS },
      },
    });

    render(
      withRenderEnvironment(
        <>
          <section aria-label="Desktop pane projection">
            <SurfaceHeader
              header={model}
              identityId="pane-desktop-identity"
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
          <section aria-label="Mobile pane projection">
            <PaneHeaderIdentity
              id="pane-mobile-identity"
              model={model}
              projection="Mobile"
            />
          </section>
        </>,
      ),
    );

    const desktopHeading = within(
      screen.getByRole("region", { name: "Desktop pane projection" }),
    ).getByRole("heading", { level: 1, name: "Solaris" });
    const desktopSupport = requireSupportLineFor(
      desktopHeading,
      "Desktop credit projection",
    );
    const desktopSupportText = normalizeText(desktopSupport.textContent);

    expect(
      within(desktopSupport)
        .getAllByRole("link")
        .map((link) => normalizeText(link.textContent)),
      `Desktop credit projection: the Desktop cap of two visible credits spans both groups, and only the resolved credit is a link; the support line read "${desktopSupportText}".`,
    ).toEqual(["Stanisław Lem"]);
    expect(
      within(desktopSupport).queryAllByText("Authors:"),
      `Desktop credit projection: an Authors group must be named for assistive technology; the support line read "${desktopSupportText}".`,
    ).toHaveLength(1);
    expect(
      within(desktopSupport).queryAllByText("Translator:"),
      `Desktop credit projection: a Role group must show its visible "{label}: " prefix; the support line read "${desktopSupportText}".`,
    ).toHaveLength(1);
    expect(
      within(desktopSupport).queryAllByText("Bill Johnston"),
      `Desktop credit projection: an unresolved credit must still be credited as text; the support line read "${desktopSupportText}".`,
    ).toHaveLength(1);
    expect(
      within(desktopSupport).queryAllByRole("link", { name: "Bill Johnston" }),
      `Desktop credit projection: an unresolved credit has nowhere to go and must not be a link; the support line read "${desktopSupportText}".`,
    ).toHaveLength(0);
    expect(
      within(desktopSupport).queryAllByText("+1"),
      `Desktop credit projection: 3 credits minus the Desktop cap of 2 must leave a "+1" hidden-credit marker; the support line read "${desktopSupportText}".`,
    ).toHaveLength(1);
    expect(
      within(desktopSupport).queryAllByText("1 more credit"),
      `Desktop credit projection: the hidden remainder must be accessible as "1 more credit"; the support line read "${desktopSupportText}".`,
    ).toHaveLength(1);
    expect(
      desktopSupportText,
      `Desktop credit projection: credits beyond the cap must not render; the support line read "${desktopSupportText}".`,
    ).not.toContain("Steve Cox");

    const mobileHeading = within(
      screen.getByRole("region", { name: "Mobile pane projection" }),
    ).getByRole("heading", { level: 1, name: "Solaris" });
    const mobileSupport = requireSupportLineFor(
      mobileHeading,
      "Mobile credit projection",
    );
    const mobileSupportText = normalizeText(mobileSupport.textContent);

    expect(
      within(mobileSupport)
        .getAllByRole("link")
        .map((link) => normalizeText(link.textContent)),
      `Mobile credit projection: the Mobile cap is one visible credit; the support line read "${mobileSupportText}".`,
    ).toEqual(["Stanisław Lem"]);
    expect(
      within(mobileSupport).queryAllByText("+2"),
      `Mobile credit projection: 3 credits minus the Mobile cap of 1 must leave a "+2" hidden-credit marker; the support line read "${mobileSupportText}".`,
    ).toHaveLength(1);
    expect(
      within(mobileSupport).queryAllByText("2 more credits"),
      `Mobile credit projection: the hidden remainder must be accessible as "2 more credits"; the support line read "${mobileSupportText}".`,
    ).toHaveLength(1);
    expect(
      mobileSupportText,
      `Mobile credit projection: the whole Translator group is beyond the Mobile cap and must not render; the support line read "${mobileSupportText}".`,
    ).not.toContain("Translator");
  });

  it("gives section and resource titles the specified --text-base, --weight-semibold, --ink, --leading-tight, start-aligned treatment", async () => {
    await applyViewport(1280, 900);

    const sectionModel = headerModel({
      href: "/lectern",
      label: "Lectern",
      publication: sectionCount(12, "item"),
    });
    const resourceModel = headerModel({
      href: "/media/m-1",
      label: "Solaris",
      publication: {
        kind: "Resource",
        resource: { status: "Ready", creditGroups: SOLARIS_CREDIT_GROUPS },
      },
    });

    render(
      withRenderEnvironment(
        <>
          {/*
            The independent oracle: the specification's title tokens applied to
            an element the projection does not own. Comparing the two <h1>s to
            each other alone would pass if both regressed to --text-xs/--ink-muted.
          */}
          <p
            style={{
              fontSize: "var(--text-base)",
              color: "var(--ink)",
              lineHeight: "var(--leading-tight)",
            }}
          >
            Specified pane title typography
          </p>
          <section aria-label="Left pane">
            <SurfaceHeader
              header={sectionModel}
              identityId={LEFT_IDENTITY_ID}
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
          <section aria-label="Right pane">
            <SurfaceHeader
              header={resourceModel}
              identityId={RIGHT_IDENTITY_ID}
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
        </>,
      ),
    );

    const probe = window.getComputedStyle(
      screen.getByText("Specified pane title typography"),
    );
    const expectedSemibold = window
      .getComputedStyle(document.documentElement)
      .getPropertyValue("--weight-semibold")
      .trim();
    const sectionHeading = within(
      screen.getByRole("region", { name: "Left pane" }),
    ).getByRole("heading", { level: 1, name: "Lectern" });
    const resourceHeading = within(
      screen.getByRole("region", { name: "Right pane" }),
    ).getByRole("heading", { level: 1, name: "Solaris" });

    const sectionType = titleTypography(sectionHeading);
    const resourceType = titleTypography(resourceHeading);

    for (const titleCase of [
      { name: "Section title (Lectern)", type: sectionType },
      { name: "Resource title (Solaris)", type: resourceType },
    ]) {
      expect(
        titleCase.type.fontSize,
        `${titleCase.name}: the pane title must be --text-base (${probe.fontSize}); it computed to ${titleCase.type.fontSize}.`,
      ).toBe(probe.fontSize);
      expect(
        titleCase.type.color,
        `${titleCase.name}: the pane title must be --ink (${probe.color}); it computed to ${titleCase.type.color}.`,
      ).toBe(probe.color);
      expect(
        titleCase.type.lineHeight,
        `${titleCase.name}: the pane title must use --leading-tight (${probe.lineHeight}); it computed to ${titleCase.type.lineHeight}.`,
      ).toBe(probe.lineHeight);
      expect(
        titleCase.type.fontWeight,
        `${titleCase.name}: the pane title must be --weight-semibold (${expectedSemibold}); it computed to ${titleCase.type.fontWeight}.`,
      ).toBe(expectedSemibold);
      expect(
        titleCase.type.textAlign,
        `${titleCase.name}: the pane title must be start-aligned; it computed to ${titleCase.type.textAlign}.`,
      ).toBe("start");
    }

    expect(
      resourceType,
      `Section (Lectern) and resource (Solaris) titles must be structurally identical typography: section computed ${JSON.stringify(sectionType)}, resource computed ${JSON.stringify(resourceType)}.`,
    ).toEqual(sectionType);
  });

  it("keeps pane-scoped heading ids when the same resource is open in two desktop panes", () => {
    const model = headerModel({
      href: "/media/m-1",
      label: "Solaris",
      publication: {
        kind: "Resource",
        resource: { status: "Ready", creditGroups: SOLARIS_CREDIT_GROUPS },
      },
    });

    render(
      withRenderEnvironment(
        <>
          <section aria-label="Left pane">
            <SurfaceHeader
              header={model}
              identityId={LEFT_IDENTITY_ID}
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
          <section aria-label="Right pane">
            <SurfaceHeader
              header={model}
              identityId={RIGHT_IDENTITY_ID}
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
        </>,
      ),
    );

    const headings = screen.getAllByRole("heading", { level: 1 });
    expect(
      headings.map((heading) => normalizeText(heading.textContent)),
      "Two panes on the same resource must each own a route-level <h1> carrying that resource's exact title.",
    ).toEqual(["Solaris", "Solaris"]);
    expect(
      headings.map((heading) => heading.getAttribute("id")),
      "Duplicate-resource panes must keep distinct pane-scoped heading ids, or one pane's landmark names the other pane's title.",
    ).toEqual([LEFT_IDENTITY_ID, RIGHT_IDENTITY_ID]);
  });

  it("ellipsizes long LTR and RTL titles at 320px, 390px and 200% text scale without shrinking, moving, or overlapping the fixed pane controls", async () => {
    const titleCases = [
      {
        name: "long unbroken LTR title",
        title: LONG_LTR_TITLE,
        direction: "ltr",
      },
      { name: "long RTL title", title: LONG_RTL_TITLE, direction: "rtl" },
    ] as const;

    const { rerender } = render(desktopHeader(libraryDetailModel(SHORT_TITLE)));

    for (const scale of TEXT_SCALES) {
      document.documentElement.style.fontSize = scale.rootFontSize;

      // Same-scale baseline: at a wide viewport a short title is not clipped and
      // the fixed controls are at their natural size.
      await applyViewport(1440, 900);
      rerender(desktopHeader(libraryDetailModel(SHORT_TITLE)));
      const baselineRegion = screen.getByRole("region", {
        name: PANE_REGION_LABEL,
      });
      const baselineHeading = within(baselineRegion).getByRole("heading", {
        level: 1,
        name: SHORT_TITLE,
      });
      expect(
        baselineHeading.scrollWidth,
        `${scale.name} @1440px baseline: the short title "${SHORT_TITLE}" must not be clipped (scrollWidth ${baselineHeading.scrollWidth}px vs clientWidth ${baselineHeading.clientWidth}px); a title that is always clipped would make the truncation assertions vacuous.`,
      ).toBeLessThanOrEqual(baselineHeading.clientWidth);
      expect(
        window.getComputedStyle(baselineHeading).direction,
        `${scale.name} @1440px baseline: a Latin title must resolve left-to-right, or the RTL assertion below proves nothing.`,
      ).toBe("ltr");
      const baselineControls = controlBoxes(baselineRegion);

      for (const viewportWidth of NARROW_VIEWPORT_WIDTHS) {
        for (const titleCase of titleCases) {
          await applyViewport(viewportWidth, 900);
          rerender(desktopHeader(libraryDetailModel(titleCase.title)));

          expectTruncatedIdentity({
            caseName: `${scale.name} @${viewportWidth}px, ${titleCase.name}`,
            paneRegion: screen.getByRole("region", { name: PANE_REGION_LABEL }),
            title: titleCase.title,
            direction: titleCase.direction,
            baselineControls,
          });
        }
      }
    }
  });

  it("ellipsizes both titles of a narrow split without shrinking or overlapping either pane's fixed controls", async () => {
    const splitRow = (leftTitle: string, rightTitle: string) =>
      withRenderEnvironment(
        <div style={{ display: "flex", width: "100%" }}>
          <section
            aria-label="Left pane"
            style={{ flex: "1 1 0", minWidth: 0 }}
          >
            <SurfaceHeader
              header={libraryDetailModel(leftTitle)}
              identityId={LEFT_IDENTITY_ID}
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
          <section
            aria-label="Right pane"
            style={{ flex: "1 1 0", minWidth: 0 }}
          >
            <SurfaceHeader
              header={libraryDetailModel(rightTitle)}
              identityId={RIGHT_IDENTITY_ID}
              options={PANE_OPTIONS}
              navigation={PANE_NAVIGATION}
            />
          </section>
        </div>,
      );

    // Baseline: the same split composition at a wide viewport, where the short
    // titles are not clipped and the control rails are at their natural size.
    await applyViewport(1280, 900);
    const { rerender } = render(splitRow(SHORT_TITLE, SHORT_TITLE));
    const baselines = {
      left: controlBoxes(screen.getByRole("region", { name: "Left pane" })),
      right: controlBoxes(screen.getByRole("region", { name: "Right pane" })),
    };
    for (const paneName of ["Left pane", "Right pane"]) {
      const baselineHeading = within(
        screen.getByRole("region", { name: paneName }),
      ).getByRole("heading", { level: 1, name: SHORT_TITLE });
      expect(
        baselineHeading.scrollWidth,
        `Narrow split baseline @1280px, ${paneName}: the short title "${SHORT_TITLE}" must not be clipped (scrollWidth ${baselineHeading.scrollWidth}px vs clientWidth ${baselineHeading.clientWidth}px).`,
      ).toBeLessThanOrEqual(baselineHeading.clientWidth);
    }

    // The specification's "narrow split" case: two panes sharing a 320px row.
    await applyViewport(320, 900);
    rerender(splitRow(LONG_LTR_TITLE, LONG_RTL_TITLE));

    expectTruncatedIdentity({
      caseName: "Narrow split @320px, left pane, long unbroken LTR title",
      paneRegion: screen.getByRole("region", { name: "Left pane" }),
      title: LONG_LTR_TITLE,
      direction: "ltr",
      baselineControls: baselines.left,
    });
    expectTruncatedIdentity({
      caseName: "Narrow split @320px, right pane, long RTL title",
      paneRegion: screen.getByRole("region", { name: "Right pane" }),
      title: LONG_RTL_TITLE,
      direction: "rtl",
      baselineControls: baselines.right,
    });
  });
});
