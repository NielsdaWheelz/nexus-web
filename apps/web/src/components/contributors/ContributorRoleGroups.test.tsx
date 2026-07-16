import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ContributorRoleGroups from "./ContributorRoleGroups";
import type { ContributorCredit } from "@/lib/contributors/types";

function credit(partial: Partial<ContributorCredit> & { credited_name: string }): ContributorCredit {
  return {
    contributor_handle: "",
    contributor_display_name: null,
    role: "author",
    href: null,
    ...partial,
  } as ContributorCredit;
}

describe("ContributorRoleGroups", () => {
  it("links ordered credited names under a pluralized Authors eyebrow", () => {
    render(
      <ContributorRoleGroups
        credits={[
          credit({
            credited_name: "Ursula K. Le Guin",
            contributor_handle: "ursula-le-guin",
            href: "/authors/ursula-le-guin",
          }),
          credit({
            credited_name: "Brian Attebery",
            contributor_handle: "brian-attebery",
            href: "/authors/brian-attebery",
          }),
        ]}
      />,
    );

    expect(screen.getByText("Authors")).toBeInTheDocument();
    const first = screen.getByRole("link", { name: "Ursula K. Le Guin" });
    expect(first).toHaveAttribute("href", "/authors/ursula-le-guin");
    expect(first).toHaveAttribute("dir", "auto");
    expect(
      screen.getByRole("link", { name: "Brian Attebery" }),
    ).toHaveAttribute("href", "/authors/brian-attebery");
  });

  it("uses the singular label for a single author", () => {
    render(
      <ContributorRoleGroups
        credits={[
          credit({ credited_name: "Toni Morrison", contributor_handle: "toni-morrison" }),
        ]}
      />,
    );
    expect(screen.getByText("Author")).toBeInTheDocument();
    expect(screen.queryByText("Authors")).not.toBeInTheDocument();
  });

  it("renders a handle-less credit as plain text, not a link", () => {
    render(
      <ContributorRoleGroups
        credits={[credit({ credited_name: "Anonymous Preview" })]}
      />,
    );
    expect(screen.getByText("Anonymous Preview")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Anonymous Preview" }),
    ).not.toBeInTheDocument();
  });

  it("groups mixed roles in vocabulary order with Authors first", () => {
    render(
      <ContributorRoleGroups
        credits={[
          credit({ credited_name: "A Host", role: "host", contributor_handle: "a-host" }),
          credit({ credited_name: "An Author", role: "author", contributor_handle: "an-author" }),
          credit({ credited_name: "A Translator", role: "translator", contributor_handle: "a-tr" }),
        ]}
      />,
    );
    const eyebrows = screen
      .getAllByText(/^(Author|Authors|Translator|Translators|Host|Hosts)$/)
      .map((node) => node.textContent);
    expect(eyebrows).toEqual(["Author", "Translator", "Host"]);
  });

  it("buckets an unknown role token into the Contributor group", () => {
    render(
      <ContributorRoleGroups
        credits={[credit({ credited_name: "Mystery", role: "sponsor", contributor_handle: "m" })]}
      />,
    );
    expect(screen.getByText("Contributor")).toBeInTheDocument();
  });

  describe("media byline", () => {
    it("shows No authors for an empty media author slice, for non-editors", () => {
      render(
        <ContributorRoleGroups
          credits={[]}
          media={{ canEditAuthors: false, authorMode: "automatic" }}
        />,
      );
      expect(screen.getByText("Authors")).toBeInTheDocument();
      expect(screen.getByText("No authors")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /author/i }),
      ).not.toBeInTheDocument();
    });

    it("offers Add author when the editable author slice is empty", () => {
      const onEditAuthors = vi.fn();
      render(
        <ContributorRoleGroups
          credits={[]}
          media={{ canEditAuthors: true, authorMode: "automatic", onEditAuthors }}
        />,
      );
      const button = screen.getByRole("button", { name: "Add author" });
      button.click();
      expect(onEditAuthors).toHaveBeenCalledOnce();
    });

    it("offers Edit authors when the editable author slice is non-empty", () => {
      render(
        <ContributorRoleGroups
          credits={[
            credit({ credited_name: "Kurt Vonnegut", contributor_handle: "kurt-vonnegut" }),
          ]}
          media={{ canEditAuthors: true, authorMode: "automatic", onEditAuthors: () => {} }}
        />,
      );
      expect(screen.getByRole("button", { name: "Edit authors" })).toBeInTheDocument();
      expect(screen.queryByText("Add author")).not.toBeInTheDocument();
    });

    it("shows the pinned marker only when manual and editable", () => {
      render(
        <ContributorRoleGroups
          credits={[credit({ credited_name: "Kurt Vonnegut", contributor_handle: "kv" })]}
          media={{ canEditAuthors: true, authorMode: "manual", onEditAuthors: () => {} }}
        />,
      );
      expect(screen.getByText("Authors edited manually")).toBeInTheDocument();
    });

    it("hides the pinned marker from non-editors even when manual", () => {
      render(
        <ContributorRoleGroups
          credits={[credit({ credited_name: "Kurt Vonnegut", contributor_handle: "kv" })]}
          media={{ canEditAuthors: false, authorMode: "manual" }}
        />,
      );
      expect(screen.queryByText("Authors edited manually")).not.toBeInTheDocument();
    });
  });

  describe("podcast byline (read-only)", () => {
    it("omits the Authors group when there are no author credits and never shows edit affordances", () => {
      render(
        <ContributorRoleGroups
          credits={[credit({ credited_name: "A Host", role: "host", contributor_handle: "a-host" })]}
        />,
      );
      const host = screen.getByText("Host");
      expect(host).toBeInTheDocument();
      expect(screen.queryByText("Authors")).not.toBeInTheDocument();
      expect(screen.queryByText("No authors")).not.toBeInTheDocument();
      expect(within(document.body).queryByRole("button")).not.toBeInTheDocument();
    });

    it("renders nothing when there are no credits at all", () => {
      const { container } = render(<ContributorRoleGroups credits={[]} />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
