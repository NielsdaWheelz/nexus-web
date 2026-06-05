import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
  EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE,
  EMAIL_IN_USE_MESSAGE,
} from "@/lib/auth/messages";

const changeEmailAction = vi.hoisted(() => vi.fn());
const apiFetch = vi.hoisted(() => vi.fn());

vi.mock("./actions", () => ({
  changeEmailAction,
}));

vi.mock("@/lib/auth/password-actions", () => ({
  setPasswordAction: vi.fn(),
  changePasswordAction: vi.fn(),
  removePasswordAction: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly requestId?: string;

    constructor(status: number, code: string, message: string, requestId?: string) {
      super(message);
      this.status = status;
      this.code = code;
      this.requestId = requestId;
    }
  },
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  isApiError: () => false,
}));

import SettingsAccountPaneBody from "./SettingsAccountPaneBody";

describe("SettingsAccountPaneBody", () => {
  it("renders the Email and Display name forms with the loaded email and display name", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      data: { email: "ada@example.com", display_name: "Ada Lovelace" },
    });

    render(<SettingsAccountPaneBody />);

    expect(
      await screen.findByText(/current: ada@example\.com/i)
    ).toBeInTheDocument();
    expect(screen.getByLabelText(/new email/i)).toHaveValue("ada@example.com");
    expect(
      screen.getByRole("button", { name: /update email/i })
    ).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByLabelText(/new display name/i)).toHaveValue(
        "Ada Lovelace"
      );
    });
    expect(screen.getByText(/current: ada lovelace/i)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /update display name/i })
    ).toBeInTheDocument();
  });

  it("does not reload account data while local form fields change", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      data: { email: "ada@example.com", display_name: "Ada" },
    });
    const user = userEvent.setup();

    render(<SettingsAccountPaneBody />);

    const nameInput = await screen.findByDisplayValue("Ada");
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await user.type(nameInput, " Updated");

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("shows a success notice when the email-change action resolves ok", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      data: { email: "ada@example.com", display_name: "Ada" },
    });
    changeEmailAction.mockReset();
    changeEmailAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    render(<SettingsAccountPaneBody />);

    const emailInput = await screen.findByDisplayValue("ada@example.com");
    await user.clear(emailInput);
    await user.type(emailInput, "ada+new@example.com");
    await user.click(screen.getByRole("button", { name: /update email/i }));

    await waitFor(() => {
      expect(
        screen.getByText(EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE)
      ).toBeInTheDocument();
    });
    expect(changeEmailAction).toHaveBeenCalledWith({
      email: "ada+new@example.com",
    });
  });

  it("shows the action's error notice when the email-change action returns ok=false", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue({
      data: { email: "ada@example.com", display_name: "Ada" },
    });
    changeEmailAction.mockReset();
    changeEmailAction.mockResolvedValue({
      ok: false,
      error: EMAIL_IN_USE_MESSAGE,
    });
    const user = userEvent.setup();

    render(<SettingsAccountPaneBody />);

    const emailInput = await screen.findByDisplayValue("ada@example.com");
    await user.clear(emailInput);
    await user.type(emailInput, "taken@example.com");
    await user.click(screen.getByRole("button", { name: /update email/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(EMAIL_IN_USE_MESSAGE);
    });
  });

  it("shows a success notice when the display-name PATCH resolves ok", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      data: { email: "ada@example.com", display_name: "Ada" },
    });
    apiFetch.mockResolvedValueOnce({
      data: { email: "ada@example.com", display_name: "Ada New" },
    });
    const user = userEvent.setup();

    render(<SettingsAccountPaneBody />);

    const nameInput = await screen.findByDisplayValue("Ada");
    await user.clear(nameInput);
    await user.type(nameInput, "Ada New");
    await user.click(
      screen.getByRole("button", { name: /update display name/i })
    );

    await waitFor(() => {
      expect(
        screen.getByText(DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE)
      ).toBeInTheDocument();
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/me", {
      method: "PATCH",
      body: JSON.stringify({ display_name: "Ada New" }),
    });
  });

  it("shows the failure message when the display-name PATCH rejects", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      data: { email: "ada@example.com", display_name: "Ada" },
    });
    apiFetch.mockRejectedValueOnce(new Error("patch failed"));
    const user = userEvent.setup();

    render(<SettingsAccountPaneBody />);

    const nameInput = await screen.findByDisplayValue("Ada");
    await user.clear(nameInput);
    await user.type(nameInput, "Ada New");
    await user.click(
      screen.getByRole("button", { name: /update display name/i })
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        DISPLAY_NAME_CHANGE_FAILURE_MESSAGE
      );
    });
  });
});
