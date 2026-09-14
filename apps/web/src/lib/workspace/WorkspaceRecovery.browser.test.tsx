import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import WorkspaceRecovery from "./WorkspaceRecovery";
import { createDefaultWorkspaceState, getWorkspacePrimaryPanes } from "./schema";
import { WorkspaceSessionStore } from "./sessionStore";

const metrics = { primaryMinWidthPx: 684, primaryDefaultWidthPx: 684 };

it.each([null, "/lectern"])("restores the selected local layout before acknowledgment, entry %s", async (entryHref) => {
  const accountId = crypto.randomUUID();
  const initialState = createDefaultWorkspaceState("/libraries", metrics);
  const stored = {
    accountId, writerId: crypto.randomUUID(), sequence: 1,
    state: createDefaultWorkspaceState("/notes", metrics),
  };
  const store = new WorkspaceSessionStore();
  await store.put(stored);
  render(<WorkspaceRecovery accountId={accountId} initialState={initialState} entryHref={entryHref} metrics={metrics}>
    {(state, recovered) => <>
      <output aria-label="Open pages">{getWorkspacePrimaryPanes(state).map((pane) => pane.currentVisit.href).join(",")}</output>
      <output aria-label="Recovery writer">{recovered?.writerId}</output>
    </>}
  </WorkspaceRecovery>);
  await userEvent.click(await screen.findByRole("button", { name: "Restore this layout" }));
  await waitFor(() => expect(screen.getByLabelText("Open pages")).toHaveTextContent("/notes"));
  if (entryHref !== null) expect(screen.getByLabelText("Open pages")).toHaveTextContent(entryHref);
  else expect(screen.getByLabelText("Open pages").textContent).toBe("/notes");
  expect(screen.getByLabelText("Recovery writer")).toHaveTextContent(stored.writerId);
  expect(await store.get(accountId, stored.writerId)).toEqual(stored);
});

it("opening the synced workspace preserves the unchosen device layout", async () => {
  const accountId = crypto.randomUUID();
  const initialState = createDefaultWorkspaceState("/libraries", metrics);
  const stored = {
    accountId, writerId: crypto.randomUUID(), sequence: 1,
    state: createDefaultWorkspaceState("/notes", metrics),
  };
  const store = new WorkspaceSessionStore();
  await store.put(stored);
  render(<WorkspaceRecovery accountId={accountId} initialState={initialState} entryHref={null} metrics={metrics}>
    {(state, recovered) => <output aria-label="Open pages">{
      recovered === null ? getWorkspacePrimaryPanes(state).map((pane) => pane.currentVisit.href).join(",") : "unexpected recovery"
    }</output>}
  </WorkspaceRecovery>);
  await userEvent.click(await screen.findByRole("button", { name: "Keep it for later; open synced workspace" }));
  expect(screen.getByLabelText("Open pages").textContent).toBe("/libraries");
  expect(await store.get(accountId, stored.writerId)).toEqual(stored);
});
