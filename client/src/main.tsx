import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { Login } from "./pages/Login";
import { AuthProvider, useAuth } from "./lib/auth";
import "./index.css";

const queryClient = new QueryClient();

/**
 * Holds the app back until /auth/me has answered, so a logged-in user never
 * sees the sign-in form flash before their session is confirmed.
 */
function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="min-h-screen bg-ivory" />;
  return user ? <App /> : <Login />;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter>
          <Gate />
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
