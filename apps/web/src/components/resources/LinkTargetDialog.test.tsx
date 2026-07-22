import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import LinkTargetDialog from "./LinkTargetDialog";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rawResourceTarget(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    kind: "resource",
    item: {
      ref: "media:11111111-1111-4111-8111-111111111111",
      scheme: "media",
      id: "11111111-1111-4111-8111-111111111111",
      label: "The Dispossessed",
      summary: "",
      route: "/media/11111111-1111-4111-8111-111111111111",
      activation: {
        resourceRef: "media:11111111-1111-4111-8111-111111111111",
        kind: "route",
        href: "/media/11111111-1111-4111-8111-111111111111",
        unresolvedReason: null,
      },
      missing: false,
      capabilities: {
        userRelation: { userLinkSource: true, userLinkTarget: "direct", noteReferenceTarget: true },
        attachable: true,
        chatSubject: "label",
        readable: "body",
        inspectable: "none",
        citableResultType: null,
        citationOutputSource: false,
        appSearchScope: false,
        conversationSearchScope: false,
        promptRender: "none",
        expansionPolicy: "none",
        expandable: false,
        adjacencySource: false,
        adjacencyTarget: true,
      },
      versionByLane: {},
    },
    existingLinkId: null,
    ...overrides,
  };
}

function stubSearch(targets: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) =>
    jsonResponse({ data: { targets, nextCursor: null } }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LinkTargetDialog", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("autofocuses the search input on open", async () => {
    stubSearch([]);
    render(<LinkTargetDialog open onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog", { name: "Link" })).toBeInTheDocument();
    // Initial focus is applied on the next animation frame.
    await waitFor(() => expect(screen.getByLabelText("Link search")).toHaveFocus());
  });

  it("renders nothing when closed", () => {
    stubSearch([]);
    render(<LinkTargetDialog open={false} onPick={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("searches purpose=link and picks a resource target without writing anything", async () => {
    const fetchMock = stubSearch([rawResourceTarget()]);
    const onPick = vi.fn();
    render(<LinkTargetDialog open onPick={onPick} onClose={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Link search"), "dispossessed");

    await screen.findByRole("option");

    const lastCall = fetchMock.mock.calls.at(-1);
    if (!lastCall) throw new Error("expected a search request");
    const [, requestInit] = lastCall;
    const body = JSON.parse(requestInit!.body as string);
    expect(body.purpose).toBe("link");
    expect(body.q).toBe("dispossessed");

    await userEvent.click(screen.getByRole("option"));
    expect(onPick).toHaveBeenCalledWith(
      {
        kind: "resource",
        ref: "media:11111111-1111-4111-8111-111111111111",
      },
      "The Dispossessed",
    );
    // The dialog itself never calls the mutation endpoint — only the search one.
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("/api/resource-items/targets/search");
    }
  });

  it("maps a picked passage target's candidateRef onto LinkTarget.candidate_ref", async () => {
    stubSearch([
      rawResourceTarget({
        kind: "passage",
        item: undefined,
        candidateRef: "content_chunk:22222222-2222-4222-8222-222222222222",
        source: rawResourceTarget().item,
        label: "Chapter 3",
        excerpt: "the ansible hummed",
        activation: {
          resourceRef: "content_chunk:22222222-2222-4222-8222-222222222222",
          kind: "none",
          href: null,
          unresolvedReason: null,
        },
      }),
    ]);
    const onPick = vi.fn();
    render(<LinkTargetDialog open onPick={onPick} onClose={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Link search"), "ansible");
    const option = await screen.findByRole("option");
    await userEvent.click(option);

    expect(onPick).toHaveBeenCalledWith(
      {
        kind: "passage",
        candidate_ref: "content_chunk:22222222-2222-4222-8222-222222222222",
      },
      "Chapter 3",
    );
  });

  it("goes busy and blocks a second pick while a commit is in flight", async () => {
    stubSearch([rawResourceTarget()]);
    const onPick = vi.fn();
    const { rerender } = render(
      <LinkTargetDialog open onPick={onPick} onClose={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText("Link search"), "dispossessed");
    const option = await screen.findByRole("option");

    // The caller flips busy once its createLink is in flight.
    rerender(<LinkTargetDialog open busy onPick={onPick} onClose={vi.fn()} />);

    // The dialog advertises its busy state and refuses further picks.
    expect(screen.getByRole("dialog", { name: "Link" })).toHaveAttribute(
      "aria-busy",
      "true",
    );
    expect(screen.getByRole("listbox")).toHaveAttribute("aria-busy", "true");
    // The keyboard path is guarded directly; the row click path is doubly
    // guarded — CSS `pointer-events: none` (enforced by the real browser) plus
    // an explicit `if (busy) return` in the handler. Bypass the pointer-events
    // gate so the click actually reaches the handler and proves the JS guard.
    await userEvent.keyboard("{Enter}");
    await userEvent.click(option, { pointerEventsCheck: 0 });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("navigates and picks with the keyboard, and closes on Escape", async () => {
    stubSearch([
      rawResourceTarget(),
      rawResourceTarget({
        item: {
          ...rawResourceTarget().item,
          ref: "media:33333333-3333-4333-8333-333333333333",
          id: "33333333-3333-4333-8333-333333333333",
          label: "Left Hand of Darkness",
        },
      }),
    ]);
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<LinkTargetDialog open onPick={onPick} onClose={onClose} />);

    const input = screen.getByLabelText("Link search");
    await userEvent.type(input, "le guin");
    expect(await screen.findAllByRole("option")).toHaveLength(2);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenLastCalledWith(
      {
        kind: "resource",
        ref: "media:33333333-3333-4333-8333-333333333333",
      },
      "Left Hand of Darkness",
    );

    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
