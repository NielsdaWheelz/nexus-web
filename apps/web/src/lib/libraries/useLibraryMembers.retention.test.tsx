import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LibraryOut } from "./contract";
import { useLibraryMembers } from "./useLibraryMembers";

const library: LibraryOut = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research",
  color: null,
  ownerUserHandle:
    "nus1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB",
  isDefault: false,
  role: "admin",
  systemKey: null,
  canRename: true,
  canDelete: true,
  canEditEntries: true,
  canManageMembers: true,
  canTransferOwnership: true,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};
const secondLibrary: LibraryOut = {
  ...library,
  id: "22222222-2222-4222-8222-222222222222",
  name: "Second research",
};
const memberHandle =
  "nus1.CCCCCCCCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD";
const governancePage = {
  data: [
    {
      userHandle: library.ownerUserHandle,
      role: "admin",
      isOwner: true,
      email: { kind: "Absent" },
      displayName: { kind: "Present", value: "Owner" },
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      userHandle: memberHandle,
      role: "member",
      isOwner: false,
      email: { kind: "Present", value: "member@example.test" },
      displayName: { kind: "Present", value: "Member" },
      createdAt: "2026-01-02T00:00:00Z",
    },
  ],
  page: { nextCursor: { kind: "Absent" } },
};
const invitationPage = {
  data: [],
  page: { nextCursor: { kind: "Absent" } },
};

function Harness() {
  const [mounted, setMounted] = useState(true);
  const controller = useLibraryMembers({
    libraryId: library.id,
    library,
    adoptLibrary: vi.fn(),
    membersActive: false,
  });
  if (!controller) throw new Error("expected controller");
  return (
    <>
      <button type="button" onClick={() => controller.setQuery("Ada")}>
        Set draft
      </button>
      <button type="button" onClick={() => setMounted((value) => !value)}>
        Toggle body
      </button>
      {mounted ? <output>{controller.draft.query}</output> : null}
    </>
  );
}

function ActiveHarness({
  adoptLibrary,
  announceAuthorityLoss,
}: {
  adoptLibrary: (next: LibraryOut | null) => void;
  announceAuthorityLoss?: (message: string) => void;
}) {
  useLibraryMembers({
    libraryId: library.id,
    library,
    adoptLibrary,
    membersActive: true,
    announceAuthorityLoss,
  });
  return null;
}

function ExternalAuthorityHarness({
  announceAuthorityLoss,
}: {
  announceAuthorityLoss: (message: string) => void;
}) {
  const [currentLibrary, setCurrentLibrary] = useState(library);
  const controller = useLibraryMembers({
    libraryId: library.id,
    library: currentLibrary,
    adoptLibrary: (next) => {
      if (next) setCurrentLibrary(next);
    },
    membersActive: false,
    announceAuthorityLoss,
  });
  if (!controller) throw new Error("expected controller");
  return (
    <>
      <button type="button" onClick={() => controller.setQuery("Ada")}>
        Set authority draft
      </button>
      <button
        type="button"
        onClick={() =>
          setCurrentLibrary((current) => ({
            ...current,
            canManageMembers: false,
          }))
        }
      >
        Lose authority
      </button>
      <output aria-label="authority state">
        {controller.snapshot.kind}:{controller.draft.query}
      </output>
    </>
  );
}

function RouteChangeHarness({
  adoptLibrary,
}: {
  adoptLibrary: (next: LibraryOut | null) => void;
}) {
  const [currentLibrary, setCurrentLibrary] = useState(library);
  useLibraryMembers({
    libraryId: currentLibrary.id,
    library: currentLibrary,
    adoptLibrary,
    membersActive: true,
  });
  return (
    <button type="button" onClick={() => setCurrentLibrary(secondLibrary)}>
      Open second Library
    </button>
  );
}

function CommandHarness() {
  const controller = useLibraryMembers({
    libraryId: library.id,
    library,
    adoptLibrary: vi.fn(),
    membersActive: true,
  });
  if (!controller) throw new Error("expected controller");
  const ready =
    controller.snapshot.kind === "Ready" ? controller.snapshot : null;
  return (
    <>
      <button
        type="button"
        disabled={!ready || controller.mutationsDisabled}
        onClick={() =>
          void controller.updateRole(memberHandle, "member", "admin")
        }
      >
        Change role
      </button>
      <button
        type="button"
        onClick={() => void controller.retryReconciliation()}
      >
        Retry reconciliation
      </button>
      <output aria-label="command state">
        {ready?.reconciliation.kind ?? controller.snapshot.kind}:
        {ready?.members.rows[1]?.role ?? "none"}:
        {controller.mutationsDisabled ? "disabled" : "enabled"}:
        {controller.announcement}
      </output>
    </>
  );
}

class LibraryMembersDefectBoundary extends Component<
  { children: ReactNode },
  { caught: { error: unknown } | null }
> {
  state = { caught: null as { error: unknown } | null };

  static getDerivedStateFromError(error: unknown) {
    return { caught: { error } };
  }

  render() {
    return this.state.caught === null ? (
      this.props.children
    ) : (
      <p>Library members defect boundary</p>
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useLibraryMembers route-owned retention", () => {
  it("routes a falsey search defect through explicit owner state to the boundary", async () => {
    const envelope = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(envelope, "data", {
      enumerable: true,
      get: () => {
        throw false;
      },
    });
    const response = new Response();
    vi.spyOn(response, "json").mockResolvedValue(envelope);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    const user = userEvent.setup();
    render(
      <LibraryMembersDefectBoundary>
        <Harness />
      </LibraryMembersDefectBoundary>,
    );

    await user.click(screen.getByRole("button", { name: "Set draft" }));

    expect(
      await screen.findByText("Library members defect boundary"),
    ).toBeInTheDocument();
  });

  it("retains its draft while the conditional Members body unmounts", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole("button", { name: "Set draft" }));
    expect(screen.getByText("Ada")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle body" }));
    expect(screen.queryByText("Ada")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Toggle body" }));
    expect(screen.getByText("Ada")).toBeInTheDocument();
  });

  it("clears the route-owned Library after a masked membership-loss 404", async () => {
    const adoptLibrary = vi.fn();
    const announceAuthorityLoss = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              code: "E_NOT_FOUND",
              message: "Library not found",
              request_id: "req-membership-loss",
            },
          }),
          {
            status: 404,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    render(
      <ActiveHarness
        adoptLibrary={adoptLibrary}
        announceAuthorityLoss={announceAuthorityLoss}
      />,
    );

    await waitFor(() => expect(adoptLibrary).toHaveBeenCalledWith(null));
    expect(announceAuthorityLoss).toHaveBeenCalledWith(
      "Library access changed. This Library is no longer available.",
    );
    vi.unstubAllGlobals();
  });

  it("adopts observed authority loss before making governance reads", async () => {
    const adoptLibrary = vi.fn();
    const announceAuthorityLoss = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { ...library, canManageMembers: false },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <ActiveHarness
        adoptLibrary={adoptLibrary}
        announceAuthorityLoss={announceAuthorityLoss}
      />,
    );

    await waitFor(() =>
      expect(adoptLibrary).toHaveBeenCalledWith({
        ...library,
        canManageMembers: false,
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(announceAuthorityLoss).toHaveBeenCalledWith(
      "Member-management access changed. Members is no longer available.",
    );
    vi.unstubAllGlobals();
  });

  it("clears stale drafts when an externally adopted projection loses authority", async () => {
    const user = userEvent.setup();
    const announceAuthorityLoss = vi.fn();
    render(
      <ExternalAuthorityHarness
        announceAuthorityLoss={announceAuthorityLoss}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Set authority draft" }),
    );
    expect(screen.getByRole("status", { name: "authority state" })).toHaveTextContent(
      "Idle:Ada",
    );
    await user.click(screen.getByRole("button", { name: "Lose authority" }));
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "authority state" }),
      ).toHaveTextContent("Idle:"),
    );
    expect(announceAuthorityLoss).toHaveBeenCalledOnce();
  });

  it("does not adopt an observation that settles after the route changes", async () => {
    const user = userEvent.setup();
    const adoptLibrary = vi.fn();
    let settleOldRoute: ((response: Response) => void) | undefined;
    const oldRouteResponse = new Promise<Response>((resolve) => {
      settleOldRoute = resolve;
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => oldRouteResponse)
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { ...secondLibrary, canManageMembers: false },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<RouteChangeHarness adoptLibrary={adoptLibrary} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await user.click(
      screen.getByRole("button", { name: "Open second Library" }),
    );
    await waitFor(() =>
      expect(adoptLibrary).toHaveBeenCalledWith({
        ...secondLibrary,
        canManageMembers: false,
      }),
    );

    await act(async () => {
      settleOldRoute?.(
        new Response(
          JSON.stringify({
            data: { ...library, canManageMembers: false },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
      await oldRouteResponse;
    });

    expect(adoptLibrary).not.toHaveBeenCalledWith({
      ...library,
      canManageMembers: false,
    });
    vi.unstubAllGlobals();
  });

  it("reconciles Library authority before governance after an expected command failure", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request ? new URL(input.url) : new URL(String(input), "http://nexus.test");
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        const call = `${method} ${url.pathname}${url.search}`;
        calls.push(call);
        if (method === "PATCH") {
          return new Response(
            JSON.stringify({
              error: {
                code: "E_FORBIDDEN",
                message: "Role authority changed",
                request_id: "req-role-conflict",
              },
            }),
            {
              status: 409,
              headers: { "content-type": "application/json" },
            },
          );
        }
        if (url.pathname === `/api/libraries/${library.id}/members`) {
          return Response.json(governancePage);
        }
        if (url.pathname === `/api/libraries/${library.id}/invites`) {
          return Response.json(invitationPage);
        }
        if (url.pathname === `/api/libraries/${library.id}`) {
          return Response.json({ data: library });
        }
        throw new Error(`Unexpected request: ${call}`);
      }),
    );

    render(<CommandHarness />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change role" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Change role" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "command state" })).toHaveTextContent(
        "Confirmed:member:enabled:No confirmed role change was applied.",
      ),
    );

    const mutation = calls.findIndex((call) => call.startsWith("PATCH "));
    const authority = calls.findIndex(
      (call, index) =>
        index > mutation && call === `GET /api/libraries/${library.id}`,
    );
    const members = calls.findIndex(
      (call, index) =>
        index > authority &&
        call.startsWith(`GET /api/libraries/${library.id}/members?`),
    );
    const invitations = calls.findIndex(
      (call, index) =>
        index > authority &&
        call.startsWith(`GET /api/libraries/${library.id}/invites?`),
    );
    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(authority).toBeGreaterThan(mutation);
    expect(members).toBeGreaterThan(authority);
    expect(invitations).toBeGreaterThan(authority);
    vi.unstubAllGlobals();
  });

  it("disables mutations after an ambiguous settlement and retries only reconciliation", async () => {
    const user = userEvent.setup();
    let mutationCalls = 0;
    let reconcileAfterMutation = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          input instanceof Request ? new URL(input.url) : new URL(String(input), "http://nexus.test");
        const method =
          init?.method ?? (input instanceof Request ? input.method : "GET");
        if (method === "PATCH") {
          mutationCalls += 1;
          reconcileAfterMutation = true;
          throw new TypeError("connection reset");
        }
        if (
          reconcileAfterMutation &&
          url.pathname === `/api/libraries/${library.id}`
        ) {
          reconcileAfterMutation = false;
          throw new TypeError("offline during reconciliation");
        }
        if (url.pathname === `/api/libraries/${library.id}/members`) {
          return Response.json(governancePage);
        }
        if (url.pathname === `/api/libraries/${library.id}/invites`) {
          return Response.json(invitationPage);
        }
        if (url.pathname === `/api/libraries/${library.id}`) {
          return Response.json({ data: library });
        }
        throw new Error(`Unexpected request: ${method} ${url.pathname}`);
      }),
    );

    render(<CommandHarness />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Change role" })).toBeEnabled(),
    );
    await user.click(screen.getByRole("button", { name: "Change role" }));
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "command state" })).toHaveTextContent(
        "Unconfirmed:member:disabled",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Retry reconciliation" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "command state" })).toHaveTextContent(
        "Confirmed:member:enabled",
      ),
    );
    expect(mutationCalls).toBe(1);
    vi.unstubAllGlobals();
  });
});
