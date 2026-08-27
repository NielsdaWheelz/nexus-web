import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SESSION_STORAGE_KEY,
  WalknoteSessionProvider,
  useWalknoteSession,
} from "./walknoteSession";

const WAYPOINT = {
  id: "bbbbbbbb-1111-4111-8111-111111111111",
  media_id: "aaaaaaaa-1111-4111-8111-111111111111",
  position_ms: 42,
  recorded_at: "2026-08-26T00:00:00Z",
  voice_text: null,
  voice_status: "idle",
} as const;

function SessionProbe() {
  const { waypoints } = useWalknoteSession();
  return <p>Waypoint count: {waypoints.length}</p>;
}

describe("Walknote session browser hydration", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("loads the exact persisted session after the client mounts", async () => {
    window.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([WAYPOINT]));

    render(
      <WalknoteSessionProvider>
        <SessionProbe />
      </WalknoteSessionProvider>,
    );

    expect(await screen.findByText("Waypoint count: 1")).toBeVisible();
  });
});
