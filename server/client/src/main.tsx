import { QueuedWork } from "./components/QueuedWork";
import { queryClient } from "./lib/queryPolicy";
import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { Login } from "./pages/Login";
import { AuthProvider, useAuth } from "./lib/auth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ForgotPassword, SetPassword, VerifyEmail } from "./pages/AccountAccess";
import { setPageTitle } from "./lib/surface";
import "./index.css";

const ClientApprovalReview = lazy(() => import("./pages/ClientApprovalReview").then((module) => ({ default: module.ClientApprovalReview })));

// index.html is shared by all three hosts and can only carry one title, so the
// tab is named for the product it actually is before anything renders.
setPageTitle();



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
  if (path === "/set-password" || path === "/payment-return" || path === "/payment/callback") return <SetPassword kind="SET_PASSWORD" />;
  if (path === "/reset-password") return <SetPassword kind="PASSWORD_RESET" />;
  if (path === "/forgot-password") return <ForgotPassword />;
  if (path === "/verify-email") return <VerifyEmail />;
  // A client reviewing changes has no account at all. This used to be a route
  // inside the signed-in app, so every reviewer was shown the sign-in screen.
  if (path.startsWith("/review/")) return <Suspense fallback={<div className="min-h-screen bg-cream" />}><ClientApprovalReview /></Suspense>;

  if (loading) return <div className="min-h-screen bg-cream" />;
  return user ? <><App /><QueuedWork /></> : <Login />;
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
