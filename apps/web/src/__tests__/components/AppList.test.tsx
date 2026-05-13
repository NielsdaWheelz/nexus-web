import { render, screen } from "@testing-library/react";
import Link from "next/link";
import { describe, expect, it } from "vitest";
import { AppList, AppListItem } from "@/components/ui/AppList";

describe("AppListItem", () => {
  it("keeps row navigation separate from contributor/action links", () => {
    render(
      <AppList>
        <AppListItem
          href="/media/media-1"
          title="Episode title"
          actions={<Link href="/authors/author-1">Author Name</Link>}
        />
      </AppList>
    );

    const rowLink = screen.getByRole("link", { name: "Episode title" });
    const contributorLink = screen.getByRole("link", { name: "Author Name" });

    expect(rowLink).toHaveAttribute("href", "/media/media-1");
    expect(contributorLink).toHaveAttribute("href", "/authors/author-1");
    expect(rowLink).not.toContainElement(contributorLink);
  });
});
