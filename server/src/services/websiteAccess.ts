import type { NextFunction, Request, Response, Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { registerEnforced } from "../middleware/permissionGate.js";
import { WebsiteError } from "./website/site.js";

export const SITE_MEMBER_ROLES = ["VIEWER", "EDITOR", "REVIEWER", "PUBLISHER", "MANAGER", "DEVELOPER"] as const;
export type WebsiteMemberRole = typeof SITE_MEMBER_ROLES[number];
export const WEBSITE_ACTIONS = ["view", "edit", "review", "publish", "manage", "members", "source"] as const;
export type WebsiteAction = typeof WEBSITE_ACTIONS[number];
export type WebsiteCapabilities = Record<WebsiteAction, boolean>;

const ROLE_ACTIONS: Record<WebsiteMemberRole, readonly WebsiteAction[]> = {
  VIEWER: ["view"],
  EDITOR: ["view", "edit"],
  REVIEWER: ["view", "review"],
  PUBLISHER: ["view", "review", "publish"],
  MANAGER: WEBSITE_ACTIONS,
  DEVELOPER: ["view", "edit", "review", "publish", "manage", "source"],
};
const ACTION_PERMISSION: Record<WebsiteAction, string> = {
  view: "website.view", edit: "website.edit", review: "website.view",
  publish: "website.publish", manage: "website.manage", members: "website.manage", source: "website.manage",
};
registerEnforced(...new Set(Object.values(ACTION_PERMISSION)));

export type WebsitePrincipal = {
  id: string;
  active: boolean;
  external: boolean;
  superAdmin: boolean;
  permissions: ReadonlySet<string>;
  deniedPermissions: readonly string[];
};

export function websitePrincipal(req: Request): WebsitePrincipal {
  const user = req.dbUser;
  if (!user?.active) throw new WebsiteError(401, "Sign in to open the website editor.");
  return {
    id: user.id, active: user.active, external: Boolean(user.accessRole?.external),
    superAdmin: Boolean(user.accessRole?.superAdmin), permissions: req.permissions ?? new Set(),
    deniedPermissions: user.deniedPermissions,
  };
}

/** Site managers do not own the OS's shared GitHub credentials. */
export function canManageWebsiteConnection(req: Request): boolean {
  return websiteCapabilities(websitePrincipal(req), null).manage;
}

export function assertWebsiteConnectionChange(req: Request, current: { repoOwner: string | null; repoName: string | null; repoBranch: string; repoPath: string }, next: Partial<typeof current>): void {
  if (["repoOwner", "repoName", "repoBranch", "repoPath"].some(key => next[key as keyof typeof next] !== undefined && next[key as keyof typeof next] !== current[key as keyof typeof current]) && !canManageWebsiteConnection(req)) {
    throw new WebsiteError(403, "Ask an administrator to change this website's repository connection. Your website settings can still be edited.");
  }
}

/** Global permissions stay internal. Site membership is the only customer grant. */
export function websiteCapabilities(principal: WebsitePrincipal, role: WebsiteMemberRole | null): WebsiteCapabilities {
  const globalView = !principal.external && (principal.superAdmin || principal.permissions.has("website.view"));
  const capabilities = Object.fromEntries(WEBSITE_ACTIONS.map(action => {
    const permission = ACTION_PERMISSION[action];
    const denied = !principal.external && !principal.superAdmin && principal.deniedPermissions.includes(permission);
    const globalGrant = globalView && (principal.superAdmin || principal.permissions.has(permission));
    return [action, principal.active && !denied && (globalGrant || Boolean(role && ROLE_ACTIONS[role]?.includes(action)))];
  })) as WebsiteCapabilities;
  // No write-only access, including when an internal account has an explicit view denial.
  if (!capabilities.view) for (const action of WEBSITE_ACTIONS) capabilities[action] = false;
  return capabilities;
}

/** Small read interface lets negative HTTP checks exercise the real gate without a database. */
export type WebsiteAccessReader = {
  memberRole(siteId: string, userId: string): Promise<WebsiteMemberRole | null>;
  pageSite(pageId: string): Promise<string | null>;
  /** Which site a shared element belongs to. Optional so a test double need not know. */
  sharedSite?(sharedElementId: string): Promise<string | null>;
  hasMembership(userId: string): Promise<boolean>;
};
const accessReader: WebsiteAccessReader = {
  memberRole: async (siteId, userId) => (await prisma.siteMember.findUnique({ where: { siteId_userId: { siteId, userId } }, select: { role: true } }))?.role ?? null,
  pageSite: async pageId => (await prisma.sitePage.findUnique({ where: { id: pageId }, select: { siteId: true } }))?.siteId ?? null,
  sharedSite: async sharedElementId => (await prisma.sharedElement.findUnique({ where: { id: sharedElementId }, select: { siteId: true } }))?.siteId ?? null,
  hasMembership: async userId => Boolean(await prisma.siteMember.findFirst({ where: { userId }, select: { id: true } })),
};

export async function getWebsiteCapabilities(req: Request, siteId: string, reader = accessReader) {
  const principal = websitePrincipal(req);
  const role = await reader.memberRole(siteId, principal.id);
  return { siteId, userId: principal.id, role, capabilities: websiteCapabilities(principal, role) };
}

export async function assertWebsiteSiteAccess(req: Request, siteId: string, action: WebsiteAction = "view", reader = accessReader) {
  const access = await getWebsiteCapabilities(req, siteId, reader);
  if (!access.capabilities.view) throw new WebsiteError(404, "That website is not available to this account.");
  if (!access.capabilities[action]) throw new WebsiteError(403, `Your access to this website does not include ${action === "members" ? "managing members" : action === "source" ? "changing source files" : action === "manage" ? "managing settings" : action === "edit" ? "editing" : action === "publish" ? "publishing" : "reviewing"}.`);
  return access;
}

/** Use on every collection and aggregate, including related page/version queries. */
export function websiteSiteFilter(req: Request): Prisma.SiteWhereInput {
  const principal = websitePrincipal(req);
  if (websiteCapabilities(principal, null).view) return {};
  if (!principal.external && principal.deniedPermissions.includes("website.view")) return { id: { in: [] } };
  return { members: { some: { userId: principal.id } } };
}

/** Route actions are resolved centrally; a new write endpoint cannot inherit view access. */
export function websiteRequestAction(method: string, path: string): WebsiteAction | null {
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE)$/.test(method)) return null;
  if (/^\/sites\/[^/]+\/agent\/publish-batch\/?$/.test(path)) return "publish";
  if (/^\/sites\/[^/]+\/hosting\/(?:domain|verify)\/?$/.test(path)) return "manage";
  if (/^\/sites\/[^/]+\/erase\/?$/.test(path)) return "manage";
  if (/^\/sites\/[^/]+\/members(?:\/[^/]+)?\/?$/.test(path)) return "members";
  if (/\/(?:source|source-project)(?:\/|$)/.test(path)) return "source";
  if (/^\/sites\/[^/]+\/config\/?$/.test(path)) return "manage";
  if (method === "GET" || method === "HEAD" || /\/presence\/?$/.test(path)) return "view";
  if (/\/publish\/?$/.test(path)) return "publish";
  // Making an element shared, or stopping it being one, changes how every page
  // that carries it is edited. Editing the shared element, detaching one page's
  // copy or putting it back are ordinary editing.
  if (/^\/sites\/[^/]+\/shared\/?$/.test(path) || /^\/shared\/[^/]+\/?$/.test(path)) return "manage";
  if (/^\/sites\/[^/]+\/onboarding\/handover\/?$/.test(path)) return "manage";
  // Pointing a site at a customer's GitHub installation is changing where it
  // publishes to, which is the same decision as changing its repository.
  if (/^\/sites\/[^/]+\/github-app\/?$/.test(path)) return "manage";
  if (/^\/shared\/[^/]+\/(?:draft|instances)(?:\/|$)/.test(path)) return "edit";
  if (/\/draft\/?$/.test(path) || /\/restore\/?$/.test(path) || /\/structure\/?$/.test(path) || /\/name-fields\/?$/.test(path)) return "edit";
  if (/\/assets(?:\/[^/]+)?\/?$/.test(path)) return "edit";
  if (/\/(?:scan|import)\/?$/.test(path)) return "manage";
  if (/^\/(?:sites|pages)\/[^/]+\/?$/.test(path)) return "manage";
  // AI suggestions, SEO actions, comments, and agent plans produce draft/site changes.
  if (/\/(?:ai|suggest|assistant|agent|seo|insert-section|comments|health-monitor)(?:\/|$)/.test(path)) return "edit";
  if (/^\/tier-status(?:\/|$)/.test(path)) return "view";
  return null;
}

export function createWebsiteAccessGate(reader = accessReader) {
  return (req: Request, _res: Response, next: NextFunction) => {
    void (async () => {
      const principal = websitePrincipal(req);
      // These routes operate on the signed-in customer's own account. Their
      // handlers check any optional site ID before using it.
      if (/^\/(?:subscription(?:\/(?:cancel|manage))?|setup-assistance)\/?$/.test(req.path)) return;
      if (/^\/tier-status(?:\/|$)/.test(req.path)) {
        return;
      }
      if (/^\/(?:sites|overview|assets)\/?$/.test(req.path) && ["GET", "HEAD"].includes(req.method)) {
        if (!websiteCapabilities(principal, null).view && !(await reader.hasMembership(principal.id))) {
          // Empty collections are useful for unassigned customers and reveal no site data.
          if (!principal.external) throw new WebsiteError(403, "This account has not been given access to a website.");
        }
        return;
      }
      // The GitHub App itself belongs to no one website: whether it exists, and
      // what one installation reaches. Staff who may connect a repository at
      // all, and nobody external — a customer must never be shown the list of
      // repositories another customer's installation reaches.
      if (/^\/github-app(?:\/|$)/.test(req.path)) {
        if (principal.external || !websiteCapabilities(principal, null).manage) {
          throw new WebsiteError(403, "Only staff with Manage sites access can set up a repository connection.");
        }
        return;
      }
      if (/^\/sites\/?$/.test(req.path) && req.method === "POST") {
        // The route checks a customer's paid entitlement and site quota before
        // creating a site; global staff permissions do not apply to customers.
        if (!principal.external && !websiteCapabilities(principal, null).manage) throw new WebsiteError(403, "Only staff with Manage sites access can connect a new website.");
        return;
      }
      const action = websiteRequestAction(req.method, req.path);
      if (!action) throw new WebsiteError(403, "That website action is not available.");
      const siteMatch = /^\/sites\/([^/]+)(?:\/|$)/.exec(req.path);
      const pageMatch = /^\/pages\/([^/]+)(?:\/|$)/.exec(req.path);
      const sharedMatch = /^\/shared\/([^/]+)(?:\/|$)/.exec(req.path);
      let siteId = siteMatch ? decodeURIComponent(siteMatch[1]) : null;
      if (pageMatch) siteId = await reader.pageSite(decodeURIComponent(pageMatch[1]));
      // A shared element is addressed on its own, so the record that says who
      // may touch it is two levels up rather than one.
      if (sharedMatch) siteId = (await reader.sharedSite?.(decodeURIComponent(sharedMatch[1]))) ?? null;
      if (!siteId) throw new WebsiteError(404, "That website page is not available.");
      await assertWebsiteSiteAccess(req, siteId, action, reader);
    })().then(() => next(), next);
  };
}
export const websiteAccessGate = createWebsiteAccessGate();

/** No manager may hand out a capability that they themselves do not hold. */
export function assertWebsiteMemberChange(input: {
  capabilities: WebsiteCapabilities; previousRole: WebsiteMemberRole | null;
  nextRole: WebsiteMemberRole | null; targetActive: boolean; activeManagerCount: number;
}) {
  if (!input.capabilities.members) throw new WebsiteError(403, "Only a website manager can change its members.");
  for (const role of [input.previousRole, input.nextRole]) {
    if (role && ROLE_ACTIONS[role].some(action => !input.capabilities[action])) {
      throw new WebsiteError(403, "You cannot assign or change a member with access beyond your own.");
    }
  }
  if (input.previousRole === "MANAGER" && input.nextRole !== "MANAGER" && input.targetActive && input.activeManagerCount <= 1) {
    throw new WebsiteError(409, "Add another active manager before removing or changing the last manager.");
  }
}

const memberSelect = { id: true, role: true, createdAt: true, updatedAt: true, user: { select: { id: true, name: true, email: true, active: true } } } satisfies Prisma.SiteMemberSelect;
const addMemberInput = z.object({
  userId: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(254).optional(),
  role: z.enum(SITE_MEMBER_ROLES),
}).strict().refine(value => Boolean(value.userId) !== Boolean(value.email), "Enter one account email or user ID.");

export function registerWebsiteMembership(router: Router) {
  const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => { void fn(req, res).catch(next); };

  router.get("/sites/:siteId/access", handle(async (req, res) => {
    res.json(await assertWebsiteSiteAccess(req, req.params.siteId));
  }));
  router.get("/sites/:siteId/members", handle(async (req, res) => {
    const access = await assertWebsiteSiteAccess(req, req.params.siteId, "members");
    const members = await prisma.siteMember.findMany({ where: { siteId: req.params.siteId }, select: memberSelect, orderBy: [{ role: "asc" }, { createdAt: "asc" }] });
    res.json({ ...access, members, assignableRoles: SITE_MEMBER_ROLES.filter(role => ROLE_ACTIONS[role].every(action => access.capabilities[action])) });
  }));

  // A site row lock serialises *all* membership changes for a site, including two
  // managers demoting each other concurrently. Re-read the actor after acquiring
  // the lock: an already-authorised HTTP request may have lost its grant while waiting.
  async function change(req: Request, nextRole: WebsiteMemberRole | null, identity?: { userId?: string; email?: string }) {
    const actor = websitePrincipal(req);
    return prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "Site" WHERE "id" = ${req.params.siteId} FOR UPDATE`;
      if (!rows.length) throw new WebsiteError(404, "That website is not available.");
      const actorRole = (await tx.siteMember.findUnique({ where: { siteId_userId: { siteId: req.params.siteId, userId: actor.id } }, select: { role: true } }))?.role ?? null;
      const capabilities = websiteCapabilities(actor, actorRole);
      if (!capabilities.members) throw new WebsiteError(403, "Only a website manager can change its members.");
      const previous = identity ? null : await tx.siteMember.findFirst({ where: { id: req.params.memberId, siteId: req.params.siteId }, include: { user: { select: { id: true, active: true } } } });
      if (!identity && !previous) throw new WebsiteError(404, "That member is not part of this website.");
      const target = previous?.user ?? await tx.user.findFirst({ where: { active: true, ...(identity?.userId ? { id: identity.userId } : { email: { equals: identity?.email?.toLowerCase(), mode: "insensitive" as const } }) }, select: { id: true, active: true } });
      if (!target) throw new WebsiteError(404, "No active account matches that email or user ID. Ask an account administrator to create it first.");
      const existing = previous ?? await tx.siteMember.findUnique({ where: { siteId_userId: { siteId: req.params.siteId, userId: target.id } } });
      if (identity && existing) throw new WebsiteError(409, "That account is already a member. Change its role in the list below.");
      const activeManagerCount = await tx.siteMember.count({ where: { siteId: req.params.siteId, role: "MANAGER", user: { active: true } } });
      assertWebsiteMemberChange({ capabilities, previousRole: existing?.role ?? null, nextRole, targetActive: target.active, activeManagerCount });
      if (nextRole && !existing) {
        const site = await tx.site.findUnique({ where: { id: req.params.siteId }, select: { clientId: true } });
        if (site?.clientId) {
          const purchase = await tx.websitePurchase.findFirst({
            where: { clientId: site.clientId, status: { in: ["ACTIVE", "READY", "SETUP_PAID", "SETUP_IN_PROGRESS", "FAILED", "CANCELLED"] } },
            orderBy: [{ activatedAt: "desc" }, { createdAt: "desc" }], select: { tier: true },
          });
          if (purchase) {
            const { WEBSITE_TIER_PLANS } = await import("./websiteTierPlans.js");
            const limit = WEBSITE_TIER_PLANS[purchase.tier].userLimit;
            const used = await tx.siteMember.count({ where: { siteId: req.params.siteId } });
            if (used >= limit) throw new WebsiteError(403, `This plan includes ${limit} team account${limit === 1 ? "" : "s"}. Upgrade before inviting another person.`);
          }
        }
      }
      const member = nextRole === null
        ? await tx.siteMember.delete({ where: { id: existing!.id }, select: memberSelect })
        : existing
          ? await tx.siteMember.update({ where: { id: existing.id }, data: { role: nextRole }, select: memberSelect })
          : await tx.siteMember.create({ data: { siteId: req.params.siteId, userId: target.id, role: nextRole }, select: memberSelect });
      await tx.siteAuditEvent.create({ data: {
        siteId: req.params.siteId, actorId: actor.id, actorName: req.dbUser?.name ?? "Website manager",
        kind: nextRole === null ? "MEMBER_REMOVED" : existing ? "MEMBER_ROLE_CHANGED" : "MEMBER_ADDED",
        summary: nextRole === null ? `Removed ${member.user.name} from the website` : `${existing ? "Changed" : "Added"} ${member.user.name} as ${nextRole.toLowerCase()}`,
        detail: { userId: target.id, previousRole: existing?.role ?? null, role: nextRole },
      } });
      return member;
    });
  }
  router.post("/sites/:siteId/members", handle(async (req, res) => {
    const input = addMemberInput.parse(req.body);
    res.status(201).json(await change(req, input.role, input));
  }));
  router.patch("/sites/:siteId/members/:memberId", handle(async (req, res) => {
    const input = z.object({ role: z.enum(SITE_MEMBER_ROLES) }).strict().parse(req.body);
    res.json(await change(req, input.role));
  }));
  router.delete("/sites/:siteId/members/:memberId", handle(async (req, res) => {
    await change(req, null);
    res.status(204).end();
  }));
}
