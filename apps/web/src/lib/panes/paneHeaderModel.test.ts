import { describe, expect, it } from "vitest";
import {
  paneHeaderAccessibleName,
  resolvePaneHeaderModel,
  type PaneHeaderModel,
} from "./paneHeaderModel";
import {
  PANE_ROUTE_MODELS,
  type PaneRouteHeaderContract,
  type PaneRouteId,
} from "./paneRouteModel";

const sectionNone = {
  kind: "section",
  destinationId: "libraries",
  defaultFolio: "none",
} as const satisfies PaneRouteHeaderContract;

const sectionLabel = {
  kind: "section",
  destinationId: "authors",
  defaultFolio: "pane-label",
} as const satisfies PaneRouteHeaderContract;

const resource = {
  kind: "resource",
  pendingLabel: "Loading media…",
} as const satisfies PaneRouteHeaderContract;

function resolve(
  routeHeader: PaneRouteHeaderContract,
  publication: Parameters<typeof resolvePaneHeaderModel>[0]["publication"] = null,
) {
  return resolvePaneHeaderModel({
    currentRouteKey: "current",
    routeHeader,
    paneLabel: "Ursula K. Le Guin",
    paneLabelPending: false,
    publication,
  });
}

const none = (standingHead: string): PaneHeaderModel => ({
  kind: "section",
  standingHead,
  folio: { kind: "none" },
  pending: false,
});
const paneLabel = (standingHead: string): PaneHeaderModel => ({
  kind: "section",
  standingHead,
  folio: { kind: "title", value: "Ursula K. Le Guin" },
  pending: false,
});

const EXPECTED_ROUTE_DEFAULTS = {
  lectern: none("Lectern"),
  libraries: none("Libraries"),
  library: none("Libraries"),
  media: {
    kind: "resource",
    resource: { status: "pending", accessibleLabel: "Loading media…" },
  },
  conversations: none("Chats"),
  conversationNew: none("Chats"),
  conversation: none("Chats"),
  podcasts: none("Podcasts"),
  podcastDetail: paneLabel("Podcasts"),
  search: none("Search"),
  author: none("Authors"),
  notes: none("Notes"),
  page: paneLabel("Notes"),
  note: paneLabel("Notes"),
  settings: none("Settings"),
  settingsAccount: none("Settings"),
  settingsBilling: none("Settings"),
  settingsReader: none("Settings"),
  settingsAppearance: none("Settings"),
  settingsKeys: none("Settings"),
  settingsLocalVault: none("Settings"),
  settingsIdentities: none("Settings"),
  settingsKeybindings: none("Settings"),
  atlas: paneLabel("Atlas"),
  oracle: paneLabel("Oracle"),
  oracleReading: paneLabel("Oracle"),
} satisfies Record<PaneRouteId, PaneHeaderModel>;

describe("resolvePaneHeaderModel", () => {
  it("resolves every route registry default to its explicit header identity", () => {
    expect(
      Object.fromEntries(
        PANE_ROUTE_MODELS.map((definition) => [
          definition.id,
          resolve(definition.header),
        ]),
      ),
    ).toEqual(EXPECTED_ROUTE_DEFAULTS);
  });

  it("resolves declared section defaults without inferring from layout", () => {
    expect(resolve(sectionNone)).toEqual({
      kind: "section",
      standingHead: "Libraries",
      folio: { kind: "none" },
      pending: false,
    });
    expect(resolve(sectionLabel)).toEqual({
      kind: "section",
      standingHead: "Authors",
      folio: { kind: "title", value: "Ursula K. Le Guin" },
      pending: false,
    });
  });

  it("marks a default pane-label folio pending with the pane label", () => {
    expect(
      resolvePaneHeaderModel({
        currentRouteKey: "current",
        routeHeader: sectionLabel,
        paneLabel: "Author",
        paneLabelPending: true,
        publication: null,
      }),
    ).toMatchObject({ kind: "section", pending: true });
  });

  it("uses a current section publication", () => {
    expect(
      resolve(sectionNone, {
        routeKey: "current",
        header: {
          kind: "section",
          folio: { kind: "count", value: 3, unit: "source" },
          pending: false,
        },
      }),
    ).toMatchObject({
      kind: "section",
      folio: { kind: "count", value: 3, unit: "source" },
    });
  });

  it("resolves an absent resource publication to typed pending", () => {
    const model = resolve(resource);
    expect(model).toEqual({
      kind: "resource",
      resource: { status: "pending", accessibleLabel: "Loading media…" },
    });
    expect(paneHeaderAccessibleName(model)).toBe("Loading media…");
  });

  it.each(["unavailable", "failed"] as const)(
    "preserves the explicit %s resource state",
    (status) => {
      const model = resolve(resource, {
        routeKey: "current",
        header: {
          kind: "resource",
          resource: { status, title: status === "failed" ? "Media failed to load" : "Media unavailable" },
        },
      });
      expect(model).toMatchObject({ kind: "resource", resource: { status } });
      expect(paneHeaderAccessibleName(model)).toContain("Media");
    },
  );

  it("preserves a ready resource title and structured credits", () => {
    const model = resolve(resource, {
      routeKey: "current",
      header: {
        kind: "resource",
        resource: {
          status: "ready",
          title: "The Left Hand of Darkness",
          creditGroups: [
            {
              kind: "authors",
              credits: [{ label: "Ursula K. Le Guin", href: "/authors/ursula" }],
            },
            {
              kind: "role",
              label: "Editor",
              credits: [{ label: "Susan Wood" }],
            },
          ],
        },
      },
    });
    expect(model).toMatchObject({
      kind: "resource",
      resource: { status: "ready", title: "The Left Hand of Darkness" },
    });
    expect(paneHeaderAccessibleName(model)).toBe("The Left Hand of Darkness");
  });

  it("ignores a stale publication before checking its kind", () => {
    expect(
      resolve(sectionNone, {
        routeKey: "stale",
        header: {
          kind: "resource",
          resource: { status: "failed", title: "Wrong route" },
        },
      }),
    ).toEqual({
      kind: "section",
      standingHead: "Libraries",
      folio: { kind: "none" },
      pending: false,
    });
  });

  it("defects on an accepted route/header kind mismatch", () => {
    expect(() =>
      resolve(resource, {
        routeKey: "current",
        header: { kind: "section", folio: { kind: "none" }, pending: false },
      }),
    ).toThrow("Resource route received a section header publication");
  });

  it("defects on invalid accepted resource identity", () => {
    expect(() =>
      resolve(resource, {
        routeKey: "current",
        header: {
          kind: "resource",
          resource: {
            status: "ready",
            title: "Valid title",
            creditGroups: [
              { kind: "authors", credits: [{ label: "One" }] },
              { kind: "authors", credits: [{ label: "Two" }] },
            ],
          },
        },
      }),
    ).toThrow("at most one authors group");
  });
});
