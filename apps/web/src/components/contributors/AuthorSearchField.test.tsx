import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AuthorSearchField, {
  normalizedNameKey,
  type AuthorSearchFieldProps,
} from "./AuthorSearchField";
import type { ContributorSearchItem } from "@/lib/contributors/types";
import { assumeContributorHandle } from "@/lib/contributors/handle";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function item(overrides: Partial<ContributorSearchItem> = {}): ContributorSearchItem {
  return {
    handle: assumeContributorHandle("ursula-le-guin"),
    href: "/authors/ursula-le-guin",
    displayName: "Ursula K. Le Guin",
    workCount: 2,
    workExamples: [],
    matchedAlias: null,
    ...overrides,
  };
}

function stubSearch(pages: Array<{ contributors: ContributorSearchItem[]; nextCursor?: string | null }>) {
  let call = 0;
  const fetchMock = vi.fn(async () => {
    const page = pages[Math.min(call, pages.length - 1)]!;
    call += 1;
    return jsonResponse({
      data: { contributors: page.contributors, nextCursor: page.nextCursor ?? null },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderField(overrides: Partial<AuthorSearchFieldProps> = {}) {
  const props: AuthorSearchFieldProps = {
    initialQuery: "",
    takenHandles: new Set(),
    takenNewNameKeys: new Set(),
    onSelectExisting: vi.fn(),
    onCreateNew: vi.fn(),
    onDismiss: vi.fn(),
    ...overrides,
  };
  const utils = render(<AuthorSearchField {...props} />);
  return { ...utils, props };
}

function type(value: string) {
  fireEvent.change(screen.getByRole("combobox"), { target: { value } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AuthorSearchField", () => {
  it("stays idle with no listbox and no fetch for an empty query", () => {
    const fetchMock = stubSearch([{ contributors: [] }]);
    renderField();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders three-line result rows and announces the count when ready", async () => {
    stubSearch([
      {
        contributors: [
          item({
            workCount: 2,
            workExamples: [
              { title: "A Wizard of Earthsea", href: "/a" },
              { title: "The Dispossessed", href: "/b" },
            ],
            matchedAlias: "U. K. Le Guin",
          }),
        ],
      },
    ]);
    renderField();
    type("le");
    const option = await screen.findByRole("option", { name: /Ursula K\. Le Guin/ });
    expect(option).toHaveTextContent("2 works");
    expect(option).toHaveTextContent("A Wizard of Earthsea");
    expect(option).toHaveTextContent("The Dispossessed");
    expect(option).toHaveTextContent("also known as U. K. Le Guin");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("1 author found"));
  });

  it("uses the singular '1 work' label", async () => {
    stubSearch([{ contributors: [item({ workCount: 1 })] }]);
    renderField();
    type("le");
    const option = await screen.findByRole("option", { name: /Ursula/ });
    expect(option).toHaveTextContent("1 work");
  });

  it("shows the truncated hint and a non-total announcement when more results exist", async () => {
    stubSearch([{ contributors: [item()], nextCursor: "cursor-2" }]);
    renderField();
    type("le");
    await screen.findByRole("option", { name: /Ursula/ });
    expect(screen.getByText("Keep typing to narrow results.")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Showing the first 1 authors — keep typing to narrow.",
      ),
    );
  });

  it("shows 'No matching authors' plus a create row when empty", async () => {
    stubSearch([{ contributors: [] }]);
    renderField();
    type("Nobody Here");
    const listbox = await screen.findByRole("listbox");
    await waitFor(() =>
      expect(within(listbox).getByText("No matching authors")).toBeInTheDocument(),
    );
    expect(
      within(listbox).getByRole("option", { name: /Create .*Nobody Here.* as a new author/ }),
    ).toBeInTheDocument();
  });

  it("offers a second 'different author' create row only when a same-name result exists", async () => {
    stubSearch([
      {
        contributors: [
          item({ displayName: "Ada Lovelace", handle: assumeContributorHandle("ada-lovelace") }),
        ],
      },
    ]);
    renderField();
    type("Ada Lovelace");
    expect(
      await screen.findByRole("option", { name: /Create a different author with this name/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /Create .*Ada Lovelace.* as a new author/ }),
    ).toBeInTheDocument();
  });

  it("renders an already-bound result disabled, not hidden, and refuses selection", async () => {
    const onSelectExisting = vi.fn();
    stubSearch([{ contributors: [item()] }]);
    renderField({ takenHandles: new Set(["ursula-le-guin"]), onSelectExisting });
    type("le");
    const option = await screen.findByRole("option", { name: /Ursula/ });
    expect(option).toHaveAttribute("aria-disabled", "true");
    expect(option).toHaveTextContent("Already added");
    fireEvent.click(option);
    expect(onSelectExisting).not.toHaveBeenCalled();
  });

  it("disables the primary create when the query matches an existing new-binding row", async () => {
    stubSearch([{ contributors: [] }]);
    renderField({ takenNewNameKeys: new Set([normalizedNameKey("Fresh Person")]) });
    type("Fresh Person");
    const create = await screen.findByRole("option", {
      name: /Create .*Fresh Person.* as a new author/,
    });
    expect(create).toHaveAttribute("aria-disabled", "true");
    expect(create).toHaveTextContent("Already added");
  });

  it("offers the distinct-create row when the same name exists only as a local new row (F4)", async () => {
    // No server result matches "John Smith" yet — only a local new-binding row
    // does. The primary create is disabled (it would silently duplicate that row),
    // but a deliberately-distinct second same-name author must still be creatable.
    stubSearch([{ contributors: [] }]);
    renderField({ takenNewNameKeys: new Set([normalizedNameKey("John Smith")]) });
    type("John Smith");
    const primary = await screen.findByRole("option", {
      name: /Create .*John Smith.* as a new author/,
    });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(
      screen.getByRole("option", { name: /Create a different author with this name/ }),
    ).toBeInTheDocument();
  });

  it("marks the active option aria-selected for the single-select combobox (M-2)", async () => {
    stubSearch([
      {
        contributors: [
          item({ displayName: "First Author", handle: assumeContributorHandle("first-author") }),
          item({ displayName: "Second Author", handle: assumeContributorHandle("second-author") }),
        ],
      },
    ]);
    renderField();
    type("au");
    // The first option is active by default.
    const first = await screen.findByRole("option", { name: /First Author/ });
    expect(first).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(screen.getByRole("combobox"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /Second Author/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
    expect(screen.getByRole("option", { name: /First Author/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("blocks results and create rows and warns when the query exceeds 200 characters", async () => {
    const fetchMock = stubSearch([{ contributors: [item()] }]);
    renderField();
    type("x".repeat(201));
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("A name can be up to 200 characters.")).toBeInTheDocument();
    expect(within(listbox).queryByRole("option")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces a request failure as a retryable error, then recovers on Try again", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) throw new Error("network down");
        return jsonResponse({ data: { contributors: [item()], nextCursor: null } });
      }),
    );
    renderField();
    type("le");
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't load authors");
    fireEvent.click(retry);
    expect(await screen.findByRole("option", { name: /Ursula/ })).toBeInTheDocument();
  });

  it("selects the active result with ArrowDown + Enter", async () => {
    const onSelectExisting = vi.fn();
    stubSearch([
      {
        contributors: [
          item({ displayName: "First Author", handle: assumeContributorHandle("first-author") }),
          item({ displayName: "Second Author", handle: assumeContributorHandle("second-author") }),
        ],
      },
    ]);
    renderField({ onSelectExisting });
    type("au");
    await screen.findByRole("option", { name: /Second Author/ });
    const input = screen.getByRole("combobox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // aria-activedescendant tracks the arrowed option (AC 27); wait for the
    // commit so Enter reads the moved active option, not the initial one.
    await waitFor(() =>
      expect(input.getAttribute("aria-activedescendant")).toMatch(/second-author/),
    );
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectExisting).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Second Author" }),
    );
  });

  it("creates a new author with Enter on the create row", async () => {
    const onCreateNew = vi.fn();
    stubSearch([{ contributors: [] }]);
    renderField({ onCreateNew });
    type("Brand New");
    await screen.findByRole("option", { name: /as a new author/ });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(onCreateNew).toHaveBeenCalledWith("Brand New");
  });

  it("owns Escape: first closes the listbox, second abandons", async () => {
    const onDismiss = vi.fn();
    stubSearch([{ contributors: [item()] }]);
    renderField({ onDismiss });
    type("le");
    await screen.findByRole("option", { name: /Ursula/ });
    const input = screen.getByRole("combobox");

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("abandons immediately for an untouched empty (Add) field on Escape", () => {
    const onDismiss = vi.fn();
    stubSearch([{ contributors: [] }]);
    renderField({ onDismiss });
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("routes Escape to the focused field when multiple searches are mounted", () => {
    const dismissFirst = vi.fn();
    const dismissSecond = vi.fn();
    const shared = {
      initialQuery: "",
      takenHandles: new Set<string>(),
      takenNewNameKeys: new Set<string>(),
      onSelectExisting: vi.fn(),
      onCreateNew: vi.fn(),
    };
    render(
      <>
        <AuthorSearchField {...shared} onDismiss={dismissFirst} />
        <AuthorSearchField {...shared} onDismiss={dismissSecond} />
      </>,
    );
    const inputs = screen.getAllByRole("combobox");
    inputs[0]!.focus();
    expect(inputs[0]).toHaveFocus();

    fireEvent.keyDown(inputs[0]!, { key: "Escape" });
    expect(dismissFirst).toHaveBeenCalledTimes(1);
    expect(dismissSecond).not.toHaveBeenCalled();
  });

  it("does not select while an IME composition is active", async () => {
    const onSelectExisting = vi.fn();
    stubSearch([{ contributors: [item()] }]);
    renderField({ onSelectExisting });
    type("le");
    await screen.findByRole("option", { name: /Ursula/ });
    const input = screen.getByRole("combobox");
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectExisting).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelectExisting).toHaveBeenCalledTimes(1);
  });
});
