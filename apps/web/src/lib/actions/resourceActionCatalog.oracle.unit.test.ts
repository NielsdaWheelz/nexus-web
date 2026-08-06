import { describe, expect, it } from "vitest";
import * as LucideIcons from "lucide-react";

import {
  MEDIA_SUBTYPES,
  RESOURCE_ACTION_LEDGER,
  RESOURCE_SCHEMES as ORACLE_RESOURCE_SCHEMES,
} from "../../../e2e/resourceActionProductOracle";
import { RESOURCE_ACTION_CATALOG } from "@/lib/actions/resourceActions";
import { LIBRARY_MEDIA_KINDS } from "@/lib/libraries/mediaKind";
import { RESOURCE_SCHEMES } from "@/lib/resourceGraph/resourceRef";

function confirmationOf(
  confirmation: (typeof RESOURCE_ACTION_CATALOG)[keyof typeof RESOURCE_ACTION_CATALOG]["confirmation"],
) {
  return confirmation.kind === "None"
    ? null
    : {
        title: confirmation.title,
        body: confirmation.body,
        confirmLabel: confirmation.confirmLabel,
      };
}

describe("RESOURCE_ACTION_CATALOG product oracle", () => {
  it("covers the reviewed 19 resource schemes and five Media subtypes", () => {
    expect(
      RESOURCE_SCHEMES,
      "the frontend ResourceRef grammar diverged from the independent 19-scheme oracle",
    ).toEqual(ORACLE_RESOURCE_SCHEMES);
    expect(
      [...LIBRARY_MEDIA_KINDS].sort(),
      "the frontend Media taxonomy does not cover every reviewed subtype",
    ).toEqual([...MEDIA_SUBTYPES].sort());
  });

  it("matches all 43 independently reviewed identities and presentation fields exactly", () => {
    const actual = Object.values(RESOURCE_ACTION_CATALOG).map((entry) => {
      const oracle = RESOURCE_ACTION_LEDGER.find(({ id }) => id === entry.id);
      if (!oracle) throw new Error(`Unclassified production action ${entry.id}`);
      const expectedIcon = LucideIcons[
        oracle.icon as keyof typeof LucideIcons
      ];
      expect(
        entry.icon,
        `${entry.id} must use the reviewed lucide-react ${oracle.icon} export by identity; received ${entry.icon.displayName ?? "unnamed icon"}`,
      ).toBe(expectedIcon);
      return {
        id: entry.id,
        group: entry.group,
        order: entry.order,
        label: entry.label,
        icon: oracle.icon,
        tone: entry.tone,
        confirmation: confirmationOf(entry.confirmation),
      };
    });
    const expected = RESOURCE_ACTION_LEDGER.map(
      ({ id, group, order, label, icon, tone, confirmation }) => ({
        id,
        group,
        order,
        label,
        icon,
        tone,
        confirmation,
      }),
    );

    expect(
      actual,
      `the production catalog must match the independent 43-action ledger exactly; actual=${JSON.stringify(actual)}`,
    ).toEqual(expected);
  });

});
