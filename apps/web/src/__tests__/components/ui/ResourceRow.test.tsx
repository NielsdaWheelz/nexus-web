import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";

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
});
