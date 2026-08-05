import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClerkProvider, SignedIn, SignedOut, RedirectToSignIn } from "@clerk/clerk-react";
import App from "./App";
import { ClerkTokenBridge } from "./ClerkTokenBridge";
import "./index.css";

const queryClient = new QueryClient();
const clerkKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>{children}</BrowserRouter>
    </QueryClientProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {clerkKey ? (
      <ClerkProvider publishableKey={clerkKey}>
        <Providers>
          <ClerkTokenBridge />
          <SignedIn>
            <App />
          </SignedIn>
          <SignedOut>
            <RedirectToSignIn />
          </SignedOut>
        </Providers>
      </ClerkProvider>
    ) : (
      <Providers>
        <App />
      </Providers>
    )}
  </React.StrictMode>
);
