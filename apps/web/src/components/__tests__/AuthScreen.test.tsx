import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AuthScreen } from "../AuthScreen.js";

const mockAuthClient = vi.hoisted(() => ({
  signIn: {
    social: vi.fn(),
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

describe("AuthScreen (Google-only sign-in)", () => {
  it("shows Owner Setup and starts Google sign-in on a fresh instance", async () => {
    mockAuthClient.signIn.social.mockResolvedValue({ data: {}, error: null });

    render(
      <AuthScreen
        authState={{
          authenticated: false,
          configured: true,
          has_owner: false,
          owner_email_restricted: false,
          providers: { google: true },
        }}
        onAuthenticated={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Owner Setup")).toBeTruthy();
    expect(screen.queryByLabelText("Email")).toBeNull();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.queryByText(/Legacy/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => {
      expect(mockAuthClient.signIn.social).toHaveBeenCalledWith({
        provider: "google",
        callbackURL: "/",
        errorCallbackURL: "/",
      });
    });
  });

  it("shows only the Google sign-in button once the owner is claimed", () => {
    render(
      <AuthScreen
        authState={{
          authenticated: false,
          configured: true,
          has_owner: true,
          owner_email_restricted: true,
          providers: { google: true },
        }}
        onAuthenticated={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Single-Owner Locked")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue with Google" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Passkey|Password|Email/i })).toBeNull();
  });

  it("shows a configuration error when Google OAuth is unavailable", () => {
    render(
      <AuthScreen
        authState={{
          authenticated: false,
          configured: true,
          has_owner: false,
          providers: { google: false },
        }}
        onAuthenticated={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Google sign-in is not configured.")).toBeTruthy();
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
          providers: { google: true },
        }}
        onAuthenticated={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("alert").textContent).toContain("allowlist or owner account");
  });
});
