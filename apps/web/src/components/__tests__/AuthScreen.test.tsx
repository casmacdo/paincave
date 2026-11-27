import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthScreen } from "../AuthScreen.js";

const mockAuthClient = vi.hoisted(() => ({
  signUp: {
    email: vi.fn(),
  },
  signIn: {
    email: vi.fn(),
    social: vi.fn(),
    passkey: vi.fn(),
  },
}));

vi.mock("../../lib/auth-client.js", () => ({
  authClient: mockAuthClient,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.history.replaceState({}, "", "/");
});

describe("AuthScreen (Single-User Better Auth)", () => {
  it("shows Owner Setup on a fresh instance and creates the single owner account", async () => {
    mockAuthClient.signUp.email.mockResolvedValue({ data: { user: { id: "u1" } }, error: null });
    const onAuthenticated = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthScreen
        authState={{
          authenticated: false,
          configured: true,
          has_owner: false,
          owner_email_restricted: false,
          providers: {
            email_password: true,
            passkey: true,
            google: false,
            github: false,
            apple: false,
            legacy_password: true,
          },
        }}
        onAuthenticated={onAuthenticated}
      />
    );

    expect(screen.getByText("Owner Setup")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Rider Owner" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "owner@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "strong-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Owner Account" }));

    await waitFor(() => {
      expect(mockAuthClient.signUp.email).toHaveBeenCalledWith({
        name: "Rider Owner",
        email: "owner@example.com",
        password: "strong-password-123",
      });
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
    });
  });

  it("shows locked single-owner Sign In with Google and Passkey buttons once claimed", async () => {
    mockAuthClient.signIn.social.mockResolvedValue({ data: {}, error: null });
    mockAuthClient.signIn.passkey.mockResolvedValue({
      data: { session: {}, user: {} },
      error: null,
    });
    const onAuthenticated = vi.fn().mockResolvedValue(undefined);

    render(
      <AuthScreen
        authState={{
          authenticated: false,
          configured: true,
          has_owner: true,
          owner_email_restricted: true,
          providers: {
            email_password: true,
            passkey: true,
            google: true,
            github: false,
            apple: false,
            legacy_password: false,
          },
        }}
        onAuthenticated={onAuthenticated}
      />
    );

    expect(screen.getByText("Single-Owner Locked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create Owner Account" })).toBeNull();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in with Passkey" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => {
      expect(mockAuthClient.signIn.social).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/",
      });
    });

    fireEvent.click(screen.getByRole("button", { name: "Sign in with Passkey" }));
    await waitFor(() => {
      expect(mockAuthClient.signIn.passkey).toHaveBeenCalledTimes(1);
      expect(onAuthenticated).toHaveBeenCalledTimes(1);
    });
  });

  it("displays an error alert when redirected back from a rejected OAuth attempt", () => {
    window.history.replaceState({}, "", "/?error=unable_to_create_user");

    render(
      <AuthScreen
        authState={{
          authenticated: false,
          configured: true,
          has_owner: true,
          owner_email_restricted: true,
          providers: {
            email_password: true,
            passkey: true,
            google: true,
            github: false,
            apple: false,
            legacy_password: false,
          },
        }}
        onAuthenticated={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("alert").textContent).toContain("single owner account");
  });
});
