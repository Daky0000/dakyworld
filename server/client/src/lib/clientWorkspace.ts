/**
 * The Website Builder as a customer sees it.
 *
 * A customer is not a member of staff with fewer permissions. Filtering the
 * internal menu down to one tab leaves them standing inside somebody else's
 * company — Leads and Costs greyed out, a dashboard they cannot open, a product
 * called "Internal Operations" — and every one of those says the same wrong
 * thing: that they are a guest in a system that is not for them.
 *
 * Kept here rather than in the header component so that it is data a check can
 * read. The rule underneath it is one line and worth enforcing: **nothing a
 * client is offered may leave the website product.**
 */

export type ClientNavItem = { to: string; label: string };

export const CLIENT_NAV: ClientNavItem[] = [
  { to: "/website/sites", label: "Pages" },
  { to: "/website/assets", label: "Assets" },
  { to: "/website/team", label: "Team" },
  { to: "/website/audit", label: "Activity" },
];

/** Where a client goes when they arrive with nothing else asked for. */
export const CLIENT_HOME = "/website/sites";

/** True for a destination this product owns. Anything else is the OS. */
export function withinClientWorkspace(path: string): boolean {
  return path === "/website" || path.startsWith("/website/");
}
