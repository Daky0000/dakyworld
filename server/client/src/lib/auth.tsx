import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, setUnauthorizedHandler } from "./api";

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: string;
};

type AuthState = {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
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
    setUser(await api.post<CurrentUser>("/auth/login", { email, password }));
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

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
