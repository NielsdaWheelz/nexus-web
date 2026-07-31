import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Component, type ReactNode } from "react";
import { renderHydratedPane } from "@/__tests__/helpers/authenticatedPane";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
  EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE,
  EMAIL_IN_USE_MESSAGE,
} from "@/lib/auth/messages";
import {
  AuthenticatedAccountProvider,
  useAuthenticatedAccount,
} from "@/lib/account/authenticatedAccount";

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

vi.mock("@/lib/api/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/client")>(
    "@/lib/api/client",
  );
  return {
    ...actual,
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
    isUnauthenticatedApiError: () => false,
  };
});

import SettingsAccountPaneBody from "./SettingsAccountPaneBody";

interface AccountWire {
  user_id: string;
  default_library_id: string;
  email: string | null;
  display_name: string | null;
  calendar_time_zone: string;
  email_ingest_address: string | null;
}

function accountResponse(overrides: Partial<AccountWire> = {}) {
  return {
    data: {
      user_id: "account-1",
      default_library_id: "library-1",
      email: "ada@example.com",
      display_name: "Ada",
      calendar_time_zone: "UTC",
      email_ingest_address: null,
      ...overrides,
    },
  };
}

class DefectBoundary extends Component<
  { children: ReactNode; onDefect: (error: unknown) => void },
  { error: unknown | null }
> {
  state: { error: unknown | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    this.props.onDefect(error);
  }

  render() {
    return this.state.error ? (
      <p>Account defect boundary</p>
    ) : (
      this.props.children
    );
  }
}

function AccountZoneProbe() {
  const { calendarTimeZone } = useAuthenticatedAccount();
  return <output aria-label="Provider calendar time zone">{calendarTimeZone}</output>;
}

function renderAccount(input: {
  resources?: Record<string, unknown>;
  onDefect?: (error: unknown) => void;
} = {}) {
  return renderHydratedPane({
    href: "/settings/account",
    resources: input.resources ?? {},
    children: (
      <AuthenticatedAccountProvider
        account={{ accountId: "account-1", calendarTimeZone: "UTC" }}
      >
        {input.onDefect ? (
          <DefectBoundary onDefect={input.onDefect}>
            <SettingsAccountPaneBody />
          </DefectBoundary>
        ) : (
          <SettingsAccountPaneBody />
        )}
        <AccountZoneProbe />
      </AuthenticatedAccountProvider>
    ),
  });
}

describe("SettingsAccountPaneBody", () => {
  it("renders the Email and Display name forms with the loaded email and display name", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(
      accountResponse({ display_name: "Ada Lovelace" }),
    );

    renderAccount();

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
    apiFetch.mockResolvedValue(accountResponse());
    const user = userEvent.setup();

    renderAccount();

    const nameInput = await screen.findByDisplayValue("Ada");
    expect(apiFetch).toHaveBeenCalledTimes(1);

    await user.type(nameInput, " Updated");

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it("shows a success notice when the email-change action resolves ok", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(accountResponse());
    changeEmailAction.mockReset();
    changeEmailAction.mockResolvedValue({ ok: true });
    const user = userEvent.setup();

    renderAccount();

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
    apiFetch.mockResolvedValue(accountResponse());
    changeEmailAction.mockReset();
    changeEmailAction.mockResolvedValue({
      ok: false,
      error: EMAIL_IN_USE_MESSAGE,
    });
    const user = userEvent.setup();

    renderAccount();

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
    apiFetch.mockResolvedValueOnce(accountResponse());
    apiFetch.mockResolvedValueOnce(
      accountResponse({ display_name: "Ada New" }),
    );
    const user = userEvent.setup();

    renderAccount();

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
    apiFetch.mockResolvedValueOnce(accountResponse());
    apiFetch.mockRejectedValueOnce(new Error("patch failed"));
    const user = userEvent.setup();

    renderAccount();

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

  it("renders the Post Room address and copy button when configured", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(
      accountResponse({
        email_ingest_address: "letters-abc@mail.example.com",
      }),
    );

    renderAccount();

    expect(
      await screen.findByText("letters-abc@mail.example.com")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /copy address/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/the post room is not configured/i)
    ).not.toBeInTheDocument();
  });

  it("renders the not-configured line when the Post Room address is null", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(accountResponse());

    renderAccount();

    expect(
      await screen.findByText(/the post room is not configured/i)
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /copy address/i })
    ).not.toBeInTheDocument();
  });

  it("copies the Post Room address to the clipboard", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValue(
      accountResponse({
        email_ingest_address: "letters-abc@mail.example.com",
      }),
    );
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockResolvedValue(undefined);
    const user = userEvent.setup();

    renderAccount();

    const button = await screen.findByRole("button", {
      name: /copy address/i,
    });
    await user.click(button);

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /copied/i })
      ).toBeInTheDocument();
    });
    expect(writeText).toHaveBeenCalledWith("letters-abc@mail.example.com");
    writeText.mockRestore();
  });

  it("updates the authenticated account time zone only after PATCH succeeds", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(accountResponse());
    apiFetch.mockResolvedValueOnce(
      accountResponse({ calendar_time_zone: "America/Los_Angeles" }),
    );
    const user = userEvent.setup();

    renderAccount();

    const input = await screen.findByLabelText("Calendar time zone");
    await waitFor(() => expect(input).toBeEnabled());
    await user.clear(input);
    await user.type(input, "America/Los_Angeles");
    expect(screen.getByLabelText("Provider calendar time zone")).toHaveTextContent(
      "UTC",
    );

    await user.click(
      screen.getByRole("button", { name: "Update calendar time zone" }),
    );

    await waitFor(() => {
      expect(
        screen.getByLabelText("Provider calendar time zone"),
      ).toHaveTextContent("America/Los_Angeles");
    });
    expect(apiFetch).toHaveBeenLastCalledWith("/api/me", {
      method: "PATCH",
      body: JSON.stringify({
        calendar_time_zone: "America/Los_Angeles",
      }),
    });
  });

  it("keeps the authenticated account time zone unchanged when PATCH fails", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(accountResponse());
    apiFetch.mockRejectedValueOnce(new Error("patch failed"));
    const user = userEvent.setup();

    renderAccount();

    const input = await screen.findByLabelText("Calendar time zone");
    await waitFor(() => expect(input).toBeEnabled());
    await user.clear(input);
    await user.type(input, "Europe/Paris");
    await user.click(
      screen.getByRole("button", { name: "Update calendar time zone" }),
    );

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Calendar time zone could not be updated.",
      );
    });
    expect(screen.getByLabelText("Provider calendar time zone")).toHaveTextContent(
      "UTC",
    );
  });

  it("exact-decodes a hydrated account seed and defects on alternate casing", async () => {
    apiFetch.mockReset();
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const malformed = accountResponse().data as Record<string, unknown>;
    malformed.calendarTimeZone = malformed.calendar_time_zone;
    delete malformed.calendar_time_zone;

    try {
      renderAccount({
        resources: {
          "settings-account:me": { data: malformed },
        },
        onDefect,
      });

      expect(
        await screen.findByText("Account defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "AuthenticatedAccountContractDefect",
        }),
      );
      expect(apiFetch).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("defects on a malformed PATCH profile before updating account context", async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(accountResponse());
    apiFetch.mockResolvedValueOnce({
      data: {
        ...accountResponse({
          calendar_time_zone: "America/Los_Angeles",
        }).data,
        unexpected: true,
      },
    });
    const onDefect = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const user = userEvent.setup();

    try {
      renderAccount({ onDefect });
      const input = await screen.findByLabelText("Calendar time zone");
      await waitFor(() => expect(input).toBeEnabled());
      await user.clear(input);
      await user.type(input, "America/Los_Angeles");
      await user.click(
        screen.getByRole("button", {
          name: "Update calendar time zone",
        }),
      );

      expect(
        await screen.findByText("Account defect boundary"),
      ).toBeInTheDocument();
      expect(onDefect).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "AuthenticatedAccountContractDefect",
        }),
      );
      expect(
        screen.getByLabelText("Provider calendar time zone"),
      ).toHaveTextContent("UTC");
    } finally {
      consoleError.mockRestore();
    }
  });
});
