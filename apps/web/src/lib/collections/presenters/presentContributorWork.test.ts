import { describe, expect, it } from "vitest";
import type { ContributorWorkItem } from "@/lib/contributors/types";
import { decodeOptionalPublicationDate } from "@/lib/dates/publicationDate";
import { presentContributorWork } from "./presentContributorWork";

describe("presentContributorWork", () => {
  it("presents title, destination, partial date, and role without repeating the page contributor", () => {
    const row = presentContributorWork(
      work({
        title: "Kalpa Imperial",
        href: "/media/kalpa",
        date: decodeOptionalPublicationDate("1983-11", "date"),
        roleFacts: [
          { creditedName: "U. K. Le Guin", role: "translator", rawRole: null },
        ],
      }),
    );

    expect(row).toMatchObject({
      id: "/media/kalpa",
      kind: "contributor_work",
      primary: { kind: "link", href: "/media/kalpa" },
      title: { text: "Kalpa Imperial" },
      contributors: [],
      publicationDate: { kind: "Present", value: "1983-11" },
      context: { kind: "Present", value: { kind: "Text", text: "Translator" } },
    });
    expect(JSON.stringify(row)).not.toContain("U. K. Le Guin");
  });

  it("keeps distinct singular role labels in first-seen order and deduplicates normalized labels", () => {
    expect(
      presentContributorWork(
        work({
          roleFacts: [
            { creditedName: "Page Author", role: "editor", rawRole: null },
            { creditedName: "P. Author", role: " editor ", rawRole: null },
            { creditedName: "Page Author", role: "translator", rawRole: null },
            { creditedName: "Page Author", role: "future_role", rawRole: null },
            { creditedName: "P. Author", role: "another_future_role", rawRole: null },
          ],
        }),
      ).context,
    ).toEqual({
      kind: "Present",
      value: { kind: "Text", text: "Editor · Translator · Contributor" },
    });
  });

  it.each(["epub", "podcast", "project_gutenberg_ebook", "future_provider_kind"])(
    "does not infer capabilities or presentation from open-ended contentKind %s",
    (contentKind) => {
      const row = presentContributorWork(
        work({
          contentKind,
          date: { kind: "Absent" },
          roleFacts: [],
        }),
      );

      expect(row.publicationDate).toEqual({ kind: "Absent" });
      expect(row.context).toEqual({ kind: "Absent" });
      expect(row.activity).toEqual({ kind: "Absent" });
      expect(row.exceptionalStatus).toEqual({ kind: "Absent" });
      expect(row.connections).toEqual({ kind: "Absent" });
      expect(row.relatedMediaId).toEqual({ kind: "Absent" });
      expect(row.actions).toEqual([]);
      expect(JSON.stringify(row)).not.toContain(contentKind);
    },
  );
});

function work(overrides: Partial<ContributorWorkItem>): ContributorWorkItem {
  return {
    title: "A Work",
    href: "/media/work",
    contentKind: "epub",
    date: decodeOptionalPublicationDate("2021", "date"),
    roleFacts: [{ creditedName: "Page Author", role: "author", rawRole: null }],
    ...overrides,
  };
}
