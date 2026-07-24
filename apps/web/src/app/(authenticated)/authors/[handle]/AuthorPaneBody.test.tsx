import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { PaneSecondaryContext } from "@/components/workspace/PaneSecondary";
import { resolvePaneRouteIdentity } from "@/lib/panes/paneIdentity";
import {
  PaneRuntimeProvider,
  type PaneResourceStatus,
} from "@/lib/panes/paneRuntime";
import type { PaneSecondaryPublication } from "@/lib/panes/panePublications";
import type { ResourceItem } from "@/lib/resources/resourceItems";
import AuthorPaneBody from "./AuthorPaneBody";

const HANDLE = "ursula-le-guin";
const CANONICAL = "Ursula K. Le Guin";
const CONTRIBUTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("AuthorPaneBody", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders canonical work rows with dates and role context but not the page contributor", async () => {
    stubRoutes({
      detail: detail({ otherNames: ["Ursula Kroeber"] }),
      works: worksPage([
        work({
          title: "A Wizard of Earthsea",
          href: "/media/earthsea",
          date: "1968",
          roleFacts: [fact({ creditedName: CANONICAL, role: "author" })],
        }),
        work({
          title: "Kalpa Imperial",
          href: "/media/kalpa",
          date: "1983-11",
          roleFacts: [fact({ creditedName: "U. K. Le Guin", role: "translator" })],
        }),
      ]),
    });

    render(authorPane());

    expect(await screen.findByRole("heading", { name: CANONICAL })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Other names" })).toBeVisible();
    expect(screen.getByText("Ursula Kroeber")).toBeVisible();

    expect(screen.getByRole("link", { name: "A Wizard of Earthsea" })).toHaveAttribute(
      "href",
      "/media/earthsea",
    );
    expect(screen.getByRole("link", { name: "Kalpa Imperial" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Works" })).toBeVisible();

    // Dates rendered at their known precision.
    expect(screen.getByText("1968")).toBeVisible();
    expect(screen.getByText("November 1983")).toBeVisible();

    // Role facts explain why each work appears here, but the page contributor is
    // not repeated in every row and contentKind is not promoted to row chrome.
    expect(screen.getByText("Author")).toBeVisible();
    expect(screen.getByText("Translator")).toBeVisible();
    expect(screen.queryByText("U. K. Le Guin")).not.toBeInTheDocument();
    expect(screen.queryByText("epub")).not.toBeInTheDocument();
  });

  it("omits the Other names section when there are none", async () => {
    stubRoutes({ detail: detail({ otherNames: [] }), works: worksPage([work({})]) });
    render(authorPane());

    expect(await screen.findByRole("heading", { name: CANONICAL })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Other names" })).not.toBeInTheDocument();
  });

  it("shows the zero-work state instead of a count", async () => {
    stubRoutes({ detail: detail({}), works: worksPage([]) });
    render(authorPane());

    expect(await screen.findByRole("heading", { name: CANONICAL })).toBeVisible();
    expect(screen.getByText("No works yet.")).toBeVisible();
    expect(screen.queryByText(/0 works/)).not.toBeInTheDocument();
  });

  it("uses the workspace-resolved contributor UUID for Connections", async () => {
    const connectionRefs: string[][] = [];
    stubFetchRouter((url, init) => {
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({});
      if (url.pathname === `/api/contributors/${HANDLE}/works`) {
        return worksPage([]);
      }
      if (url.pathname === "/api/resource-graph/connections/query") {
        connectionRefs.push(
          (JSON.parse(String(init?.body)) as { refs: string[] }).refs,
        );
        return jsonResponse({ data: { items: [], next_cursor: null } });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(
      <AuthorSecondaryHarness>
        {authorPane({
          resourceItem: paneResourceItem(`contributor:${CONTRIBUTOR_ID}`),
        })}
      </AuthorSecondaryHarness>,
    );

    expect(await screen.findByRole("heading", { name: CANONICAL })).toBeVisible();
    expect(await screen.findByText("No connected objects yet.")).toBeVisible();
    expect(connectionRefs).toEqual([
      [`contributor:${CONTRIBUTOR_ID}`],
    ]);
    expect(connectionRefs).not.toContainEqual([`contributor:${HANDLE}`]);
  });

  it("publishes a non-querying Connections placeholder until the contributor ref resolves", async () => {
    stubRoutes({ detail: detail({}), works: worksPage([]) });
    const view = render(
      <AuthorSecondaryHarness>
        {authorPane({ resourceStatus: "pending" })}
      </AuthorSecondaryHarness>,
    );

    expect(await screen.findByRole("heading", { name: CANONICAL })).toBeVisible();
    expect(await screen.findByText("Loading connections…")).toBeVisible();

    view.rerender(
      <AuthorSecondaryHarness>
        {authorPane({
          resourceItem: paneResourceItem("contributor:not-a-uuid"),
        })}
      </AuthorSecondaryHarness>,
    );
    expect(await screen.findByText("Connections unavailable")).toBeVisible();
    expect(
      screen.getByText("This author’s resource identity could not be resolved."),
    ).toBeVisible();
  });

  it("shows initial-load feedback without rendering stale author content", async () => {
    stubRoutes({
      detail: errorResponse(500, "E_INTERNAL", "boom"),
      works: worksPage([work({ title: "Must not render" })]),
    });
    render(authorPane());

    expect(await screen.findByText("Couldn't load this author.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: CANONICAL })).toBeNull();
    expect(screen.queryByRole("list", { name: "Works" })).toBeNull();
    expect(screen.queryByText("Must not render")).toBeNull();
  });

  it("appends the next page when Load more is pressed", async () => {
    const cursors: Array<string | null> = [];
    stubFetchRouter((url) => {
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({});
      if (url.pathname === `/api/contributors/${HANDLE}/works`) {
        cursors.push(url.searchParams.get("cursor"));
        if (url.searchParams.get("cursor") === "cursor-2") {
          return worksPage([work({ title: "Second Page Work", href: "/media/p2" })]);
        }
        return worksPage([work({ title: "First Page Work", href: "/media/p1" })], "cursor-2");
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(authorPane());

    expect(await screen.findByRole("link", { name: "First Page Work" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    const secondPageWork = await screen.findByRole("link", { name: "Second Page Work" });
    expect(secondPageWork).toBeVisible();
    await waitFor(() => expect(secondPageWork).toHaveFocus());
    expect(screen.getByRole("link", { name: "First Page Work" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more" })).not.toBeInTheDocument();
    expect(cursors).toEqual([null, "cursor-2"]);
  });

  it("retains rows and offers Try again when a Load more page fails", async () => {
    let failNext = true;
    stubFetchRouter((url) => {
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({});
      if (url.pathname === `/api/contributors/${HANDLE}/works`) {
        if (url.searchParams.get("cursor") === "cursor-2") {
          if (failNext) {
            failNext = false;
            return errorResponse(500, "E_INTERNAL", "boom");
          }
          return worksPage([work({ title: "Recovered Work", href: "/media/ok" })]);
        }
        return worksPage([work({ title: "First Page Work", href: "/media/p1" })], "cursor-2");
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(authorPane());

    expect(await screen.findByRole("link", { name: "First Page Work" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    const tryAgain = await screen.findByRole("button", { name: "Try again" });
    // Existing rows survive the failure.
    expect(screen.getByRole("link", { name: "First Page Work" })).toBeVisible();

    fireEvent.click(tryAgain);
    expect(await screen.findByRole("link", { name: "Recovered Work" })).toBeVisible();
  });

  it("hides the rename action when the viewer cannot rename", async () => {
    stubRoutes({ detail: detail({ canRename: false }), works: worksPage([work({})]) });
    render(authorPane());

    expect(await screen.findByRole("heading", { name: CANONICAL })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Edit name" })).not.toBeInTheDocument();
  });

  it("renames the author and shows a success toast", async () => {
    let patchBody: { clientMutationId?: string; displayName?: string } | null = null;
    stubFetchRouter((url, init) => {
      if (url.pathname === `/api/contributors/${HANDLE}` && init?.method === "PATCH") {
        patchBody = JSON.parse(init.body as string);
        return detail({ displayName: "Ursula Le Guin" });
      }
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({ canRename: true });
      if (url.pathname === `/api/contributors/${HANDLE}/works`) return worksPage([work({})]);
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(authorPane());

    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    expect(
      within(dialog).getByText(
        "Used across Nexus. Each work keeps the name it was credited under.",
      ),
    ).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText("Author name"), {
      target: { value: "Ursula Le Guin" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(patchBody?.displayName).toBe("Ursula Le Guin");
      expect(typeof patchBody?.clientMutationId).toBe("string");
    });
    expect(await screen.findByText("Author name updated.")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Ursula Le Guin" })).toBeVisible();
  });

  it("blocks an empty rename and keeps Save disabled until the name changes", async () => {
    stubRoutes({ detail: detail({ canRename: true }), works: worksPage([work({})]) });
    render(authorPane());

    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    // Prefilled + unchanged → Save disabled.
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Author name"), {
      target: { value: "   " },
    });
    expect(within(dialog).getByText("Enter a name.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();

    fireEvent.change(within(dialog).getByLabelText("Author name"), {
      target: { value: "New Name" },
    });
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("surfaces the replay-mismatch title on a 409", async () => {
    stubFetchRouter((url, init) => {
      if (url.pathname === `/api/contributors/${HANDLE}` && init?.method === "PATCH") {
        return errorResponse(409, "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH", "replay");
      }
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({ canRename: true });
      if (url.pathname === `/api/contributors/${HANDLE}/works`) return worksPage([work({})]);
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(authorPane());
    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    fireEvent.change(within(dialog).getByLabelText("Author name"), {
      target: { value: "Ursula Le Guin" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText("That author change changed. Reload and try again."),
    ).toBeVisible();
    // Dialog stays open with the draft retained.
    expect(within(dialog).getByLabelText("Author name")).toHaveValue("Ursula Le Guin");
  });

  it("rotates the mutation id after a 409 replay mismatch (matches the editor, spec §7)", async () => {
    const mutationIds: string[] = [];
    stubFetchRouter((url, init) => {
      if (url.pathname === `/api/contributors/${HANDLE}` && init?.method === "PATCH") {
        mutationIds.push(JSON.parse(init.body as string).clientMutationId);
        return errorResponse(409, "E_IDEMPOTENCY_KEY_REPLAY_MISMATCH", "replay");
      }
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({ canRename: true });
      if (url.pathname === `/api/contributors/${HANDLE}/works`) return worksPage([work({})]);
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(authorPane());
    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    fireEvent.change(within(dialog).getByLabelText("Author name"), {
      target: { value: "Ursula Le Guin" },
    });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText("That author change changed. Reload and try again."),
    ).toBeVisible();
    await waitFor(() => expect(mutationIds).toHaveLength(1));

    // The draft is unchanged and Save is enabled again; a second Save reuses the
    // same payload but must mint a fresh id — the prior key is now bound to a
    // different server request (a retained key would deterministically re-409).
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mutationIds).toHaveLength(2));
    expect(mutationIds[1]).not.toBe(mutationIds[0]);
  });

  it("shows the transport copy and reuses the mutation id on a network failure", async () => {
    const mutationIds: string[] = [];
    let failNext = true;
    stubFetchRouter((url, init) => {
      if (url.pathname === `/api/contributors/${HANDLE}` && init?.method === "PATCH") {
        mutationIds.push(JSON.parse(init.body as string).clientMutationId);
        if (failNext) {
          failNext = false;
          throw new TypeError("network down");
        }
        return detail({ displayName: "Ursula Le Guin" });
      }
      if (url.pathname === `/api/contributors/${HANDLE}`) return detail({ canRename: true });
      if (url.pathname === `/api/contributors/${HANDLE}/works`) return worksPage([work({})]);
      throw new Error(`unexpected path ${url.pathname}`);
    });

    render(authorPane());
    fireEvent.click(await screen.findByRole("button", { name: "Edit name" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit name" });
    fireEvent.change(within(dialog).getByLabelText("Author name"), {
      target: { value: "Ursula Le Guin" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));

    expect(
      await within(dialog).findByText("Couldn't confirm the change. Try again."),
    ).toBeVisible();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(screen.getByText("Author name updated.")).toBeVisible();
    });
    // The same key was replayed across the transport-uncertain retry.
    expect(mutationIds).toHaveLength(2);
    expect(mutationIds[0]).toBe(mutationIds[1]);
  });
});

// --- helpers -------------------------------------------------------------

function authorPane({
  resourceItem = null,
  resourceStatus = "none",
}: {
  resourceItem?: ResourceItem | null;
  resourceStatus?: PaneResourceStatus;
} = {}) {
  const href = `/authors/${HANDLE}`;
  return (
    <FeedbackProvider>
      <PaneRuntimeProvider
        paneId="pane-1"
        isActive={true}
        href={href}
        routeId="author"
        routeKey={resolvePaneRouteIdentity(href).routeKey}
        resourceItem={resourceItem}
        resourceStatus={resourceStatus}
        canGoBack={false}
        canGoForward={false}
        onGoBackPane={vi.fn()}
        onGoForwardPane={vi.fn()}
        pathParams={{ handle: HANDLE }}
        onNavigatePane={() => {}}
        onReplacePane={() => {}}
        onOpenInNewPane={() => {}}
      >
        <AuthorPaneBody />
      </PaneRuntimeProvider>
    </FeedbackProvider>
  );
}

function AuthorSecondaryHarness({ children }: { children: ReactNode }) {
  const [publication, setPublication] =
    useState<PaneSecondaryPublication | null>(null);
  const connections = publication?.surfaces.find(
    (surface) => surface.id === "resource-connections",
  );
  return (
    <PaneSecondaryContext.Provider value={setPublication}>
      {children}
      {connections?.body}
    </PaneSecondaryContext.Provider>
  );
}

function paneResourceItem(ref: string): ResourceItem {
  const [scheme = "", id = ""] = ref.split(":", 2);
  return {
    ref,
    scheme,
    id,
    label: CANONICAL,
    summary: "",
    route: `/authors/${HANDLE}`,
    activation: {
      resourceRef: ref,
      kind: "route",
      href: `/authors/${HANDLE}`,
      unresolvedReason: null,
    },
    missing: false,
    capabilities: {
      userRelation: {
        userLinkSource: true,
        userLinkTarget: "direct",
        noteReferenceTarget: false,
      },
      attachable: true,
      chatSubject: "label",
      readable: "none",
      inspectable: "none",
      citableResultType: null,
      citationOutputSource: false,
      appSearchScope: false,
      conversationSearchScope: false,
      promptRender: "label",
      expansionPolicy: "none",
      expandable: false,
      adjacencySource: false,
      adjacencyTarget: true,
      sharing: "CopyOnly",
    },
    versionByLane: {},
  };
}

function detail(over: Record<string, unknown>): Response {
  return jsonResponse({
    data: {
      handle: HANDLE,
      href: `/authors/${HANDLE}`,
      displayName: CANONICAL,
      otherNames: [],
      canRename: false,
      ...over,
    },
  });
}

function worksPage(works: unknown[], nextCursor: string | null = null): Response {
  return jsonResponse({ data: { works, nextCursor } });
}

function work(over: Record<string, unknown>) {
  return {
    title: "A Work",
    href: "/media/w1",
    contentKind: "epub",
    date: null,
    roleFacts: [fact({ creditedName: CANONICAL, role: "author" })],
    ...over,
  };
}

function fact(over: { creditedName: string; role: string }) {
  return { creditedName: over.creditedName, role: over.role, rawRole: null };
}

function stubRoutes({ detail: detailResponse, works }: { detail: Response; works: Response }) {
  stubFetchRouter((url) => {
    if (url.pathname === `/api/contributors/${HANDLE}`) return detailResponse.clone();
    if (url.pathname === `/api/contributors/${HANDLE}/works`) return works.clone();
    throw new Error(`unexpected path ${url.pathname}`);
  });
}

function stubFetchRouter(
  handler: (url: URL, init?: RequestInit) => Response,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (path: string | Request, init?: RequestInit) => {
      const raw = path instanceof Request ? path.url : String(path);
      return handler(new URL(raw, "https://nexus.test"), init);
    }),
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
