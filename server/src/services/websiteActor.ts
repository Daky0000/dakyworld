import type { UserWithAccess } from "../lib/accessRoles.js";

/** The identity inputs shared by HTTP handlers and background commands. */
export interface WebsiteActor {
  dbUser?: UserWithAccess;
  permissions?: Set<string>;
  headers: Record<string, string | string[] | undefined>;
}
