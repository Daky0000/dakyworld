import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setUnauthorizedHandler } from "./api";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  /** The legacy enum. Kept for display; it decides nothing — see `permissions`. */
  role: string;
  roleId: string | null;
  roleName: string | null;
  /**
   * Everything this person may do, resolved by the server.
   *
   * The client never works this out for itself. Before this the navigation
   * carried its own copy of the rules — an `ownerOnly` flag and a `roles`
   * array per tab — which had to be kept in step by hand with twenty
   * `requireRole` lines on the API, and the symptom of getting it wrong was a
   * tab that led straight to a 403.
   */
  permissions: string[];
  twoFactorEnabled?: boolean;
};

/**
 * A password that was right, on an account that also wants a code. The
 * challenge is a short-lived signed ticket, not a session — nothing is
 * authenticated until `completeLogin` comes back.
 */
export type MfaChallenge = { mfaRequired: true; challenge: string };

type LoginResult = CurrentUser | MfaChallenge;

export function isMfaChallenge(result: LoginResult): result is MfaChallenge {
  return (result as MfaChallenge).mfaRequired === true;
}

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  /**
   * Whether this person may do one particular thing.
   *
   * Hiding a control is a courtesy, not a security boundary — the API refuses
   * the same call whatever the client renders. What it buys is that nobody is
   * shown a button that can only ever answer "your role does not include this".
   */
  can: (permission: string) => boolean;
  /** Resolves to the signed-in user, or to the challenge that has to be answered first. */
  login: (email: string, password: string) => Promise<LoginResult>;
  completeLogin: (challenge: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  // One call on mount decides between the app and the login screen. A 401 here
  // is the expected "not logged in" answer, not an error worth surfacing.
  useEffect(() => {
    let cancelled = false;
    api
      .get<CurrentUser>("/auth/me")
      .then((me) => !cancelled && setUser(me))
      .catch(() => !cancelled && setUser(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  // If a session expires or is revoked while the tab is open, any 401 drops
  // straight back to the login screen instead of leaving a dead-looking UI.
  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const result = await api.post<LoginResult>("/auth/login", { email, password });
    // Only a real user goes into state. Setting one from a challenge would
    // render the whole app behind a login that has not finished.
    if (!isMfaChallenge(result)) setUser(result);
    return result;
  }, []);

  const completeLogin = useCallback(async (challenge: string, code: string) => {
    setUser(await api.post<CurrentUser>("/auth/login/2fa", { challenge, code }));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch (err) {
      // An already-dead session still means logged out as far as the UI goes.
      if (!(err instanceof ApiError)) throw err;
    }
    setUser(null);
  }, []);

  const can = useCallback((permission: string) => user?.permissions?.includes(permission) ?? false, [user]);

  return (
    <AuthContext.Provider value={{ user, loading, can, login, completeLogin, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
