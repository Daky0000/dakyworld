import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { Login } from "./pages/Login";
import { AuthProvider, useAuth } from "./lib/auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ForgotPassword, SetPassword, VerifyEmail } from "./pages/AccountAccess";
import "./index.css";

const queryClient = new QueryClient();

/**
 * Holds the app back until /auth/me has answered, so a logged-in user never
 * sees the sign-in form flash before their session is confirmed.
 */
function Gate() {
  const { user, loading } = useAuth();

  // These four are reached by people who cannot sign in — a customer who has
  // just paid and has no password yet, or somebody who has forgotten theirs —
  // so they are answered from the path before the session is even considered.
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path === "/set-password") return <SetPassword kind="SET_PASSWORD" />;
  if (path === "/reset-password") return <SetPassword kind="PASSWORD_RESET" />;
  if (path === "/forgot-password") return <ForgotPassword />;
  if (path === "/verify-email") return <VerifyEmail />;

  if (loading) return <div className="min-h-screen bg-cream" />;
  return user ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <ErrorBoundary label="app">
            <Gate />
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
