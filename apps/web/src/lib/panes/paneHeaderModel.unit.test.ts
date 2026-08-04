import { describe, expect, it } from "vitest";
import {
  paneHeaderAccessibleName,
  resolvePaneHeaderModel,
  type PaneHeaderCreditGroup,
  type PaneHeaderMeta,
  type PaneHeaderModel,
} from "./paneHeaderModel";
import type { PaneRouteHeaderContract } from "./paneRouteModel";

/**
 * Risk: pane identity is the only visible route title after the canonical
 * pane-title cutover (`docs/cutovers/canonical-pane-title-ownership-hard-cutover.md`).
 * If resolution accepts a superseded publication, silently tolerates a
 * contract/publication kind mismatch, or lets volatile support data leak into
 * the landmark name, the user reads the wrong pane's identity — and assistive
 * technology announces it.
 *
 * Oracle: that specification's route-declaration, header-publication,
 * resolved-model, and landmark clauses. Of the destination labels asserted
 * below, only two are named by the spec itself: its target-behavior table gives
 * `Settings` as the support line of a Settings child and `Chats` as the support
 * line of a conversation. `Libraries` and `Notes` are not in that table — they
 * are the labels the destination registry (`lib/navigation/destinations.ts`)
 * carries for the `libraries` and `notes` destination ids that the route table
 * assigns to the `library` and `notes` routes. All four are written here as
 * literals rather than read back from the registry, so this proof cannot agree
 * with a broken resolver.
 */

// Route contracts exactly as PANE_ROUTE_MODELS declares them for these routes.
const NOTES_INDEX: PaneRouteHeaderContract = {
  kind: "Section",
  destinationId: "notes",
  context: "None",
};

const SETTINGS_ACCOUNT: PaneRouteHeaderContract = {
  kind: "Section",
  destinationId: "settings",
  context: "Destination",
};

const CONVERSATION: PaneRouteHeaderContract = {
  kind: "Section",
  destinationId: "chats",
  context: "Destination",
};

const LIBRARY_DETAIL: PaneRouteHeaderContract = {
  kind: "Section",
  destinationId: "libraries",
  context: "Destination",
};

const MEDIA_RESOURCE: PaneRouteHeaderContract = {
  kind: "Resource",
  pendingLabel: "Loading media…",
};

// Route keys are `${routeId}:${normalizedHref}`, the pane runtime's fencing value.
const NOTES_ROUTE_KEY = "notes:/notes";
const SETTINGS_ACCOUNT_ROUTE_KEY = "settingsAccount:/settings/account";
const CONVERSATION_ROUTE_KEY = "conversation:/conversations/7c2e";
const HYPERION_ROUTE_KEY = "media:/media/9b1c";
const ENDYMION_ROUTE_KEY = "media:/media/4d7a";

const HYPERION_CREDITS: readonly PaneHeaderCreditGroup[] = [
  {
    kind: "Authors",
    credits: [{ label: "Dan Simmons", href: "/authors/dan-simmons" }],
  },
  { kind: "Role", label: "Narrator", credits: [{ label: "Marc Vietor" }] },
];

const NOTES_DEFAULT_MODEL: PaneHeaderModel = {
  kind: "Section",
  title: "Notes",
  titlePending: false,
  context: { kind: "Absent" },
  meta: { kind: "None" },
};

describe("pane header resolution", () => {
  it("ignores a publication stamped with a superseded route key and falls back to route defaults on both Section and Resource panes", () => {
    const staleNotesCount = resolvePaneHeaderModel({
      currentRouteKey: NOTES_ROUTE_KEY,
      routeHeader: NOTES_INDEX,
      paneLabel: "Notes",
      paneLabelPending: false,
      publication: {
        routeKey: "notes:/notes?tag=archive",
        header: { kind: "Section", meta: { kind: "Count", value: 42, unit: "page" } },
      },
    });
    expect(
      staleNotesCount,
      `Section route "${NOTES_ROUTE_KEY}" holding a publication stamped ` +
        `"notes:/notes?tag=archive" must resolve to route defaults ` +
        `(meta None, absent context, title from the pane label), not the stale ` +
        `Count 42 page.`,
    ).toEqual(NOTES_DEFAULT_MODEL);

    const staleHyperionCredits = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: {
        routeKey: ENDYMION_ROUTE_KEY,
        header: {
          kind: "Resource",
          resource: { status: "Ready", creditGroups: HYPERION_CREDITS },
        },
      },
    });
    expect(
      staleHyperionCredits,
      `Resource route "${HYPERION_ROUTE_KEY}" holding a publication stamped ` +
        `"${ENDYMION_ROUTE_KEY}" must resolve to the route pending state ` +
        `("Loading media…"), never the previous resource's Ready credits.`,
    ).toEqual({
      kind: "Resource",
      title: "Hyperion",
      resource: { status: "Pending", accessibleLabel: "Loading media…" },
    } satisfies PaneHeaderModel);

    // The route-key fence runs before the kind check: a publication left behind
    // by a *different kind* of route is an ordinary mid-navigation race, so it
    // must be dropped rather than reported as a kind mismatch.
    const staleAcrossKinds = resolvePaneHeaderModel({
      currentRouteKey: NOTES_ROUTE_KEY,
      routeHeader: NOTES_INDEX,
      paneLabel: "Notes",
      paneLabelPending: false,
      publication: {
        routeKey: ENDYMION_ROUTE_KEY,
        header: { kind: "Resource", resource: { status: "Failed" } },
      },
    });
    expect(
      staleAcrossKinds,
      `Section route "${NOTES_ROUTE_KEY}" holding a superseded Resource ` +
        `publication from "${ENDYMION_ROUTE_KEY}" must resolve to route ` +
        `defaults; staleness is a race, not a defect.`,
    ).toEqual(NOTES_DEFAULT_MODEL);
  });

  it("rejects a current-route publication whose kind contradicts the route contract as a defect", () => {
    expect(
      () =>
        resolvePaneHeaderModel({
          currentRouteKey: NOTES_ROUTE_KEY,
          routeHeader: NOTES_INDEX,
          paneLabel: "Notes",
          paneLabelPending: false,
          publication: {
            routeKey: NOTES_ROUTE_KEY,
            header: { kind: "Resource", resource: { status: "Unavailable" } },
          },
        }),
      `Section route "${NOTES_ROUTE_KEY}" receiving a Resource publication for ` +
        `its own route key is an impossible state and must throw naming that ` +
        `contract violation, not resolve.`,
    ).toThrow(/Section pane route received a Resource header publication/);

    expect(
      () =>
        resolvePaneHeaderModel({
          currentRouteKey: HYPERION_ROUTE_KEY,
          routeHeader: MEDIA_RESOURCE,
          paneLabel: "Hyperion",
          paneLabelPending: false,
          publication: {
            routeKey: HYPERION_ROUTE_KEY,
            header: { kind: "Section", meta: { kind: "None" } },
          },
        }),
      `Resource route "${HYPERION_ROUTE_KEY}" receiving a Section publication ` +
        `for its own route key is an impossible state and must throw naming ` +
        `that contract violation, not resolve.`,
    ).toThrow(/Resource pane route received a Section header publication/);
  });

  it("resolves Section context to the destination label and omits it when the exact title is already that label", () => {
    const notesIndex = resolvePaneHeaderModel({
      currentRouteKey: NOTES_ROUTE_KEY,
      routeHeader: NOTES_INDEX,
      paneLabel: "Field Notes",
      paneLabelPending: false,
      publication: null,
    });
    expect(
      notesIndex,
      `context "None" on route "${NOTES_ROUTE_KEY}" must stay Absent even when ` +
        `the title ("Field Notes") differs from the "Notes" destination label.`,
    ).toEqual({
      kind: "Section",
      title: "Field Notes",
      titlePending: false,
      context: { kind: "Absent" },
      meta: { kind: "None" },
    } satisfies PaneHeaderModel);

    const settingsAccount = resolvePaneHeaderModel({
      currentRouteKey: SETTINGS_ACCOUNT_ROUTE_KEY,
      routeHeader: SETTINGS_ACCOUNT,
      paneLabel: "Account",
      paneLabelPending: false,
      publication: null,
    });
    expect(
      settingsAccount,
      `context "Destination" on route "${SETTINGS_ACCOUNT_ROUTE_KEY}" must ` +
        `surface the "settings" destination label "Settings" beside the exact ` +
        `title "Account".`,
    ).toEqual({
      kind: "Section",
      title: "Account",
      titlePending: false,
      context: { kind: "Present", value: "Settings" },
      meta: { kind: "None" },
    } satisfies PaneHeaderModel);

    const conversation = resolvePaneHeaderModel({
      currentRouteKey: CONVERSATION_ROUTE_KEY,
      routeHeader: CONVERSATION,
      paneLabel: "Why Hyperion endures",
      paneLabelPending: false,
      publication: null,
    });
    expect(
      conversation,
      `context "Destination" on route "${CONVERSATION_ROUTE_KEY}" must surface ` +
        `the "chats" destination label "Chats" beside the exact conversation title.`,
    ).toEqual({
      kind: "Section",
      title: "Why Hyperion endures",
      titlePending: false,
      context: { kind: "Present", value: "Chats" },
      meta: { kind: "None" },
    } satisfies PaneHeaderModel);

    // A library that happens to be named "Libraries" must not read "Libraries — Libraries".
    const libraryNamedAfterItsDestination = resolvePaneHeaderModel({
      currentRouteKey: "library:/libraries/3f11",
      routeHeader: LIBRARY_DETAIL,
      paneLabel: "Libraries",
      paneLabelPending: false,
      publication: null,
    });
    expect(
      libraryNamedAfterItsDestination,
      `context "Destination" on route "library:/libraries/3f11" must be Absent ` +
        `when the exact title already equals the "libraries" destination label ` +
        `"Libraries"; redundant context is omitted.`,
    ).toEqual({
      kind: "Section",
      title: "Libraries",
      titlePending: false,
      context: { kind: "Absent" },
      meta: { kind: "None" },
    } satisfies PaneHeaderModel);
  });

  it("makes the pane label the Section title, mirrors label pendency independently of metadata, and defects on a blank pane label", () => {
    const conversationResolving = resolvePaneHeaderModel({
      currentRouteKey: CONVERSATION_ROUTE_KEY,
      routeHeader: CONVERSATION,
      paneLabel: "New chat",
      paneLabelPending: true,
      publication: {
        routeKey: CONVERSATION_ROUTE_KEY,
        header: {
          kind: "Section",
          meta: { kind: "Count", value: 3, unit: "message" },
        },
      },
    });
    expect(
      conversationResolving,
      `Route "${CONVERSATION_ROUTE_KEY}" with paneLabelPending=true must report ` +
        `titlePending=true and keep the pane label "New chat" as the title, ` +
        `while still carrying the published Count 3 message metadata.`,
    ).toEqual({
      kind: "Section",
      title: "New chat",
      titlePending: true,
      context: { kind: "Present", value: "Chats" },
      meta: { kind: "Count", value: 3, unit: "message" },
    } satisfies PaneHeaderModel);

    const conversationResolved = resolvePaneHeaderModel({
      currentRouteKey: CONVERSATION_ROUTE_KEY,
      routeHeader: CONVERSATION,
      paneLabel: "Why Hyperion endures",
      paneLabelPending: false,
      publication: {
        routeKey: CONVERSATION_ROUTE_KEY,
        header: { kind: "Section", meta: { kind: "Pending" } },
      },
    });
    expect(
      conversationResolved,
      `Route "${CONVERSATION_ROUTE_KEY}" with paneLabelPending=false must report ` +
        `titlePending=false even while the published metadata is still Pending; ` +
        `title pendency tracks the label, never the support facts.`,
    ).toEqual({
      kind: "Section",
      title: "Why Hyperion endures",
      titlePending: false,
      context: { kind: "Present", value: "Chats" },
      meta: { kind: "Pending" },
    } satisfies PaneHeaderModel);

    for (const blankLabel of ["", "   ", "\n\t"]) {
      expect(
        () =>
          resolvePaneHeaderModel({
            currentRouteKey: NOTES_ROUTE_KEY,
            routeHeader: NOTES_INDEX,
            paneLabel: blankLabel,
            paneLabelPending: false,
            publication: null,
          }),
        `Section route "${NOTES_ROUTE_KEY}" with pane label ` +
          `${JSON.stringify(blankLabel)} must throw for the blank pane label ` +
          `itself: the label is the only title value, so a blank one leaves the ` +
          `pane with no identity.`,
      ).toThrow(/Pane label must be non-empty/);

      expect(
        () =>
          resolvePaneHeaderModel({
            currentRouteKey: HYPERION_ROUTE_KEY,
            routeHeader: MEDIA_RESOURCE,
            paneLabel: blankLabel,
            paneLabelPending: false,
            publication: null,
          }),
        `Resource route "${HYPERION_ROUTE_KEY}" with pane label ` +
          `${JSON.stringify(blankLabel)} must throw for the same blank pane ` +
          `label — not for its (valid) pending label; "Loading media…" ` +
          `describes loading and never substitutes for identity.`,
      ).toThrow(/Pane label must be non-empty/);
    }
  });

  it("keeps the pane label as the Resource title across the route pending state and the published Unavailable and Failed terminal states, and defects on a blank pending label", () => {
    const expectedPending: PaneHeaderModel = {
      kind: "Resource",
      title: "Hyperion",
      resource: { status: "Pending", accessibleLabel: "Loading media…" },
    };

    const noPublicationAtAll = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: null,
    });
    expect(
      noPublicationAtAll,
      `Resource route "${HYPERION_ROUTE_KEY}" with no publication record must ` +
        `resolve to { status: "Pending", accessibleLabel: "Loading media…" } and ` +
        `keep "Hyperion" as the title.`,
    ).toEqual(expectedPending);

    const currentRecordWithoutHeader = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: { routeKey: HYPERION_ROUTE_KEY },
    });
    expect(
      currentRecordWithoutHeader,
      `Resource route "${HYPERION_ROUTE_KEY}" whose current-route publication ` +
        `record omits its header means "route defaults" and must resolve to the ` +
        `same pending state as no record at all.`,
    ).toEqual(expectedPending);

    const unavailableMedia = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: {
        routeKey: HYPERION_ROUTE_KEY,
        header: { kind: "Resource", resource: { status: "Unavailable" } },
      },
    });
    expect(
      unavailableMedia,
      `Resource route "${HYPERION_ROUTE_KEY}" publishing status "Unavailable" ` +
        `for its own route key must carry that terminal status through and keep ` +
        `the pane label "Hyperion" as the title — an unavailable resource still ` +
        `owes the pane a non-empty identity, and must not fall back to the ` +
        `pending state.`,
    ).toEqual({
      kind: "Resource",
      title: "Hyperion",
      resource: { status: "Unavailable" },
    } satisfies PaneHeaderModel);

    const failedMedia = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: {
        routeKey: HYPERION_ROUTE_KEY,
        header: { kind: "Resource", resource: { status: "Failed" } },
      },
    });
    expect(
      failedMedia,
      `Resource route "${HYPERION_ROUTE_KEY}" publishing status "Failed" for ` +
        `its own route key must carry that terminal status through and keep the ` +
        `pane label "Hyperion" as the title; a failure is never allowed to ` +
        `rewrite pane identity into an error string.`,
    ).toEqual({
      kind: "Resource",
      title: "Hyperion",
      resource: { status: "Failed" },
    } satisfies PaneHeaderModel);

    for (const blankPendingLabel of ["", "   "]) {
      expect(
        () =>
          resolvePaneHeaderModel({
            currentRouteKey: HYPERION_ROUTE_KEY,
            routeHeader: { kind: "Resource", pendingLabel: blankPendingLabel },
            paneLabel: "Hyperion",
            paneLabelPending: false,
            publication: null,
          }),
        `Resource route "${HYPERION_ROUTE_KEY}" declaring pendingLabel ` +
          `${JSON.stringify(blankPendingLabel)} beside the valid pane label ` +
          `"Hyperion" must throw for the blank pending label itself: every ` +
          `pending state owes the user a non-empty identity.`,
      ).toThrow(/Resource pending label must be non-empty/);
    }
  });

  it("rejects Count metadata outside a non-negative integer with a unit and Date metadata that is not a real date-only ISO day", () => {
    // Each case carries the defect it must provoke, so a case cannot pass by
    // tripping an earlier guard than the rule it exists to prove.
    const rejected: readonly (readonly [string, PaneHeaderMeta, RegExp])[] = [
      [
        "negative count",
        { kind: "Count", value: -1, unit: "page" },
        /count must be a non-negative integer/,
      ],
      [
        "fractional count",
        { kind: "Count", value: 2.5, unit: "page" },
        /count must be a non-negative integer/,
      ],
      [
        "not a number",
        { kind: "Count", value: Number.NaN, unit: "page" },
        /count must be a non-negative integer/,
      ],
      [
        "empty unit",
        { kind: "Count", value: 3, unit: "" },
        /count unit must be non-empty/,
      ],
      [
        "whitespace unit",
        { kind: "Count", value: 3, unit: "  " },
        /count unit must be non-empty/,
      ],
      [
        "month out of range",
        { kind: "Date", iso: "2026-13-01" },
        /date must be a date-only ISO calendar day/,
      ],
      [
        "day beyond month length",
        { kind: "Date", iso: "2026-02-30" },
        /date must be a date-only ISO calendar day/,
      ],
      [
        "Feb 29 of a non-leap year",
        { kind: "Date", iso: "2026-02-29" },
        /date must be a date-only ISO calendar day/,
      ],
      [
        "unpadded month and day",
        { kind: "Date", iso: "2026-8-3" },
        /date must be a date-only ISO calendar day/,
      ],
      [
        "date-time rather than date-only",
        { kind: "Date", iso: "2026-08-03T10:00:00Z" },
        /date must be a date-only ISO calendar day/,
      ],
      [
        "free text",
        { kind: "Date", iso: "yesterday" },
        /date must be a date-only ISO calendar day/,
      ],
      [
        "empty iso",
        { kind: "Date", iso: "" },
        /date must be a date-only ISO calendar day/,
      ],
    ];

    for (const [caseName, meta, expectedDefect] of rejected) {
      expect(
        () =>
          resolvePaneHeaderModel({
            currentRouteKey: NOTES_ROUTE_KEY,
            routeHeader: NOTES_INDEX,
            paneLabel: "Notes",
            paneLabelPending: false,
            publication: {
              routeKey: NOTES_ROUTE_KEY,
              header: { kind: "Section", meta },
            },
          }),
        `Section route "${NOTES_ROUTE_KEY}" published ${caseName} ` +
          `(${JSON.stringify(meta)}); Count must be a non-negative integer with a ` +
          `non-empty unit and Date must be a valid date-only ISO calendar day, so ` +
          `this must throw ${expectedDefect} rather than reach the support line.`,
      ).toThrow(expectedDefect);
    }

    const accepted: readonly PaneHeaderMeta[] = [
      { kind: "Pending" },
      { kind: "Count", value: 0, unit: "page" },
      { kind: "Count", value: 1204, unit: "page" },
      { kind: "Date", iso: "2024-02-29" },
    ];

    for (const meta of accepted) {
      expect(
        resolvePaneHeaderModel({
          currentRouteKey: NOTES_ROUTE_KEY,
          routeHeader: NOTES_INDEX,
          paneLabel: "Notes",
          paneLabelPending: false,
          publication: {
            routeKey: NOTES_ROUTE_KEY,
            header: { kind: "Section", meta },
          },
        }),
        `Section route "${NOTES_ROUTE_KEY}" published the valid metadata ` +
          `${JSON.stringify(meta)}; it must reach the resolved model unchanged.`,
      ).toEqual({
        kind: "Section",
        title: "Notes",
        titlePending: false,
        context: { kind: "Absent" },
        meta,
      } satisfies PaneHeaderModel);
    }
  });

  it("rejects Ready credit groups that are empty, blank-labelled, or carry a second Authors group", () => {
    // As above: the expected defect travels with the case so a blank Role label
    // cannot pass by tripping the empty-group or credit-label rule instead.
    const rejected: readonly (readonly [
      string,
      readonly PaneHeaderCreditGroup[],
      RegExp,
    ])[] = [
      [
        "an Authors group with no credits",
        [{ kind: "Authors", credits: [] }],
        /credit group must list at least one credit/,
      ],
      [
        "a Role group with no credits",
        [{ kind: "Role", label: "Narrator", credits: [] }],
        /credit group must list at least one credit/,
      ],
      [
        "a blank credit label",
        [{ kind: "Authors", credits: [{ label: "   " }] }],
        /credit label must be non-empty/,
      ],
      [
        "a blank Role label",
        [{ kind: "Role", label: "", credits: [{ label: "Marc Vietor" }] }],
        /credit role label must be non-empty/,
      ],
      [
        "two Authors groups",
        [
          { kind: "Authors", credits: [{ label: "Dan Simmons" }] },
          { kind: "Authors", credits: [{ label: "Ursula K. Le Guin" }] },
        ],
        /at most one Authors credit group/,
      ],
    ];

    for (const [caseName, creditGroups, expectedDefect] of rejected) {
      expect(
        () =>
          resolvePaneHeaderModel({
            currentRouteKey: HYPERION_ROUTE_KEY,
            routeHeader: MEDIA_RESOURCE,
            paneLabel: "Hyperion",
            paneLabelPending: false,
            publication: {
              routeKey: HYPERION_ROUTE_KEY,
              header: {
                kind: "Resource",
                resource: { status: "Ready", creditGroups },
              },
            },
          }),
        `Resource route "${HYPERION_ROUTE_KEY}" published Ready credits with ` +
          `${caseName} (${JSON.stringify(creditGroups)}); every group must credit ` +
          `at least one contributor, every credit and Role label must be ` +
          `non-blank, and at most one Authors group may exist, so this must throw ` +
          `${expectedDefect}.`,
      ).toThrow(expectedDefect);
    }

    const creditlessArtifact = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: {
        routeKey: HYPERION_ROUTE_KEY,
        header: { kind: "Resource", resource: { status: "Ready", creditGroups: [] } },
      },
    });
    expect(
      creditlessArtifact,
      `Resource route "${HYPERION_ROUTE_KEY}" published Ready with zero credit ` +
        `groups — the artifact case — which is legitimate and must resolve to a ` +
        `Ready state carrying no credits.`,
    ).toEqual({
      kind: "Resource",
      title: "Hyperion",
      resource: { status: "Ready", creditGroups: [] },
    } satisfies PaneHeaderModel);

    const oneAuthorsGroupAndTwoRoles: readonly PaneHeaderCreditGroup[] = [
      { kind: "Authors", credits: [{ label: "Dan Simmons" }] },
      { kind: "Role", label: "Narrator", credits: [{ label: "Marc Vietor" }] },
      { kind: "Role", label: "Translator", credits: [{ label: "Anna Halloran" }] },
    ];
    const fullyCredited = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: {
        routeKey: HYPERION_ROUTE_KEY,
        header: {
          kind: "Resource",
          resource: { status: "Ready", creditGroups: oneAuthorsGroupAndTwoRoles },
        },
      },
    });
    expect(
      fullyCredited,
      `Resource route "${HYPERION_ROUTE_KEY}" published one Authors group beside ` +
        `two distinct Role groups; only Authors is capped at one, so all three ` +
        `groups must reach the resolved model unchanged.`,
    ).toEqual({
      kind: "Resource",
      title: "Hyperion",
      resource: { status: "Ready", creditGroups: oneAuthorsGroupAndTwoRoles },
    } satisfies PaneHeaderModel);
  });

  it("names the pane landmark with the exact title plus present context only, never count, date, credits, or a pending placeholder", () => {
    const notesWithCount = resolvePaneHeaderModel({
      currentRouteKey: NOTES_ROUTE_KEY,
      routeHeader: NOTES_INDEX,
      paneLabel: "Notes",
      paneLabelPending: false,
      publication: {
        routeKey: NOTES_ROUTE_KEY,
        header: { kind: "Section", meta: { kind: "Count", value: 128, unit: "page" } },
      },
    });
    expect(
      paneHeaderAccessibleName(notesWithCount),
      `Section route "${NOTES_ROUTE_KEY}" with absent context must name the ` +
        `landmark with the exact title alone, so the published Count 128 page ` +
        `never becomes part of a volatile landmark name.`,
    ).toBe("Notes");

    const settingsAccountWithDate = resolvePaneHeaderModel({
      currentRouteKey: SETTINGS_ACCOUNT_ROUTE_KEY,
      routeHeader: SETTINGS_ACCOUNT,
      paneLabel: "Account",
      paneLabelPending: false,
      publication: {
        routeKey: SETTINGS_ACCOUNT_ROUTE_KEY,
        header: { kind: "Section", meta: { kind: "Date", iso: "2026-08-03" } },
      },
    });
    expect(
      paneHeaderAccessibleName(settingsAccountWithDate),
      `Section route "${SETTINGS_ACCOUNT_ROUTE_KEY}" with present context ` +
        `"Settings" must name the landmark "Account — Settings" and drop the ` +
        `published Date 2026-08-03 entirely.`,
    ).toBe("Account — Settings");

    const settingsAccountResolving = resolvePaneHeaderModel({
      currentRouteKey: SETTINGS_ACCOUNT_ROUTE_KEY,
      routeHeader: SETTINGS_ACCOUNT,
      paneLabel: "Account",
      paneLabelPending: true,
      publication: null,
    });
    expect(
      paneHeaderAccessibleName(settingsAccountResolving),
      `Section route "${SETTINGS_ACCOUNT_ROUTE_KEY}" resolving its label ` +
        `(titlePending=true) must name the landmark exactly "Account — Settings". ` +
        `Pendency is an aria-busy state on the identity; no loading word may be ` +
        `spliced into the landmark name.`,
    ).toBe("Account — Settings");

    const hyperionReady = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Hyperion",
      paneLabelPending: false,
      publication: {
        routeKey: HYPERION_ROUTE_KEY,
        header: {
          kind: "Resource",
          resource: { status: "Ready", creditGroups: HYPERION_CREDITS },
        },
      },
    });
    expect(
      paneHeaderAccessibleName(hyperionReady),
      `Resource route "${HYPERION_ROUTE_KEY}" in Ready state must name the ` +
        `landmark with the exact work title alone, never the "Dan Simmons" / ` +
        `"Marc Vietor" credits beside it.`,
    ).toBe("Hyperion");

    const mediaPending = resolvePaneHeaderModel({
      currentRouteKey: HYPERION_ROUTE_KEY,
      routeHeader: MEDIA_RESOURCE,
      paneLabel: "Media",
      paneLabelPending: false,
      publication: null,
    });
    expect(
      paneHeaderAccessibleName(mediaPending),
      `Resource route "${HYPERION_ROUTE_KEY}" in Pending state must still name ` +
        `the landmark from the pane label "Media"; the pending label ` +
        `"Loading media…" is support copy, not the landmark name.`,
    ).toBe("Media");
  });
});
