import { useEffect } from "react";
import { useAuth } from "@clerk/clerk-react";
import { setTokenGetter } from "./lib/api";

/** Only ever mounted inside a real ClerkProvider — wires Clerk's session token into the API client. */
export function ClerkTokenBridge() {
  const { getToken } = useAuth();
  useEffect(() => {
    setTokenGetter(() => getToken());
  }, [getToken]);
  return null;
}
