import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import type { LinkedIdentity } from "@/lib/auth/identities";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const setPasswordAction = vi.hoisted(() => vi.fn());
const changePasswordAction = vi.hoisted(() => vi.fn());
const removePasswordAction = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/password-actions", () => ({
  setPasswordAction,
  changePasswordAction,
  removePasswordAction,
}));

import { PasswordRow } from "./PasswordRow";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000014",
);

function renderPasswordRow(node: ReactNode) {
  return render(
    withRenderEnvironment(
      <FeedbackProvider>
        <PaneReturnMementoProvider>
          <PaneReturnVisitScope
            visitId={TEST_VISIT_ID}
            routeKey="/settings/identities"
          >
            <LibraryPlacementControllerProvider>
              <ShareControllerProvider>{node}</ShareControllerProvider>
            </LibraryPlacementControllerProvider>
          </PaneReturnVisitScope>
        </PaneReturnMementoProvider>
      </FeedbackProvider>,
    ),
  );
}

function googleIdentity(): LinkedIdentity {
  return {
    id: "google-id",
    provider: "google",
    email: "owner+google@example.com",
    createdAt: "2026-03-21T00:00:00Z",
  };
}

function emailIdentity(): LinkedIdentity {
  return {
    id: "email-id",
    provider: "email",
    email: "owner@example.com",
    createdAt: "2026-03-21T00:00:00Z",
  };
}

describe("PasswordRow", () => {
  it("renders a Set password button and opens a dialog with a password input when no email identity exists", async () => {
    const user = userEvent.setup();
    renderPasswordRow(
      <PasswordRow identities={[googleIdentity()]} onChanged={vi.fn()} />,
    );

    const setButton = screen.getByRole("button", { name: /set password/i });
    expect(setButton).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /change password/i })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /remove password/i })
    ).toBeNull();

    await user.click(setButton);

    expect(screen.getByRole("dialog")).toHaveAttribute(
      "aria-label",
      "Set password"
    );
    expect(screen.getByLabelText(/new password/i)).toHaveAttribute(
      "type",
      "password"
    );
  });

  it("renders the email support line, primary Change action, and overflow Remove action", async () => {
    const user = userEvent.setup();
    renderPasswordRow(
      <PasswordRow
        identities={[emailIdentity(), googleIdentity()]}
        onChanged={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/password is set on owner@example\.com/i)
    ).toBeInTheDocument();
    const changeButton = screen.getByRole("button", {
      name: /change password/i,
    });
    const actionsButton = screen.getByRole("button", {
      name: "More actions for Password",
    });
    expect(changeButton).toBeEnabled();
    await user.click(actionsButton);
    expect(
      screen.getByRole("menuitem", { name: "Remove password" })
    ).toBeEnabled();
  });

  it("does not expose Remove password when the email identity is the only one", () => {
    renderPasswordRow(
      <PasswordRow identities={[emailIdentity()]} onChanged={vi.fn()} />,
    );

    expect(
      screen.queryByRole("button", { name: "More actions for Password" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Change password" })
    ).toBeEnabled();
  });
});
