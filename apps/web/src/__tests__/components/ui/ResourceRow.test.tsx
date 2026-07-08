import { FileText } from "lucide-react";
import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { horizontallyScrollableElements } from "@/__tests__/helpers/horizontalOverflow";
import ContributorCreditList from "@/components/contributors/ContributorCreditList";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceThumb from "@/components/ui/ResourceThumb";

describe("ResourceRow", () => {
  it("renders a real link row and keeps actions outside the link", () => {
    render(
      <ResourceList>
        <ResourceRow
          primary={{
            kind: "link",
            href: "/media/media-1",
            paneTitleHint: "Media title",
          }}
          title="Media title"
          actions={<a href="https://example.test/authors/author-1">Author Name</a>}
        />
      </ResourceList>,
    );

    const rowLink = screen.getByRole("link", { name: "Media title" });
    const actionLink = screen.getByRole("link", { name: "Author Name" });

    expect(rowLink).toHaveAttribute("href", "/media/media-1");
    expect(rowLink).toHaveAttribute("data-pane-title-hint", "Media title");
    expect(actionLink).toHaveAttribute(
      "href",
      "https://example.test/authors/author-1",
    );
    expect(rowLink).not.toContainElement(actionLink);
  });

  it("keeps contributor links outside the primary link", () => {
    render(
      <ResourceList>
        <ResourceRow
          primary={{ kind: "link", href: "/media/media-1" }}
          title="Media title"
          contributors={<a href="https://example.test/authors/author-1">Author Name</a>}
        />
      </ResourceList>,
    );

    const rowLink = screen.getByRole("link", { name: "Media title" });
    const contributorLink = screen.getByRole("link", { name: "Author Name" });

    expect(rowLink).not.toContainElement(contributorLink);
  });

  it("renders a real button row and keeps actions from activating it", async () => {
    const user = userEvent.setup();
    const onActivate = vi.fn();
    const onAction = vi.fn();

    render(
      <ResourceList>
        <ResourceRow
          primary={{
            kind: "button",
            label: "Open item",
            onActivate,
          }}
          title="Item title"
          actions={<button onClick={onAction}>Row action</button>}
        />
      </ResourceList>,
    );

    await user.click(screen.getByRole("button", { name: "Row action" }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onActivate).not.toHaveBeenCalled();

    const primary = screen.getByRole("button", { name: "Open item" });
    await user.click(primary);
    expect(onActivate).toHaveBeenCalledTimes(1);

    await user.click(screen.getByText("Item title"));
    expect(onActivate).toHaveBeenCalledTimes(2);

    primary.focus();
    await user.keyboard("{Enter}");
    expect(onActivate).toHaveBeenCalledTimes(3);
  });

  it("disables busy button rows", () => {
    const onActivate = vi.fn();

    render(
      <ResourceList>
        <ResourceRow
          primary={{
            kind: "button",
            label: "Open item",
            busy: true,
            onActivate,
          }}
          title="Item title"
        />
      </ResourceList>,
    );

    const button = screen.getByRole("button", { name: "Open item" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");

    expect(onActivate).not.toHaveBeenCalled();
  });

  it("renders static rows without an activation role", () => {
    render(
      <ResourceList>
        <ResourceRow primary={{ kind: "static" }} title="Static item" />
      </ResourceList>,
    );

    expect(screen.getByText("Static item")).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("keeps populated rows inside a 320px narrow container", () => {
    render(
      <div
        data-testid="narrow-row-host"
        style={{ width: "320px", maxWidth: "320px" }}
      >
        <ResourceList>
          <ResourceRow
            primary={{ kind: "link", href: "/media/long-row" }}
            leading={
              <ResourceThumb
                spec={{ icon: FileText }}
                alt="A very long narrow resource row"
              />
            }
            title="A very long narrow resource row title that should stay readable without creating horizontal overflow"
            description="This description represents secondary context that should not force the card wider than the viewport."
            meta="Publisher With A Very Long Name · 2026 · A signal that needs to clamp on narrow rows"
            badges={<span>Research status with a long label</span>}
            contributors={
              <ContributorCreditList
                credits={[
                  {
                    contributor_handle: "first-contributor",
                    contributor_display_name: "First Contributor With A Long Name",
                    credited_name: "First Contributor With A Long Name",
                    role: "author",
                    href: "/authors/first-contributor",
                  },
                  {
                    contributor_handle: "second-contributor",
                    contributor_display_name: "Second Contributor With A Long Name",
                    credited_name: "Second Contributor With A Long Name",
                    role: "editor",
                    href: "/authors/second-contributor",
                  },
                ]}
                showRole
              />
            }
            secondary={<button type="button">↳ 14 connected</button>}
            actions={<button type="button">Secondary action with long label</button>}
          />
        </ResourceList>
      </div>,
    );

    const host = screen.getByTestId("narrow-row-host");
    expect(host.clientWidth).toBe(320);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth + 1);
    expect(horizontallyScrollableElements(host)).toEqual([]);
    expect(screen.getByRole("link", { name: /narrow resource row title/ })).toHaveAttribute(
      "href",
      "/media/long-row",
    );
  });
});
