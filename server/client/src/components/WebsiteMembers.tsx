import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { SiteSummary } from "../lib/types";
import { Button, PageHeader } from "./ui";

type MemberRole = "VIEWER" | "EDITOR" | "REVIEWER" | "PUBLISHER" | "MANAGER" | "DEVELOPER";
type Member = { id: string; role: MemberRole; user: { id: string; name: string; email: string; active: boolean }; createdAt: string };
export type WebsiteCapabilities = Record<"view" | "edit" | "review" | "publish" | "manage" | "members" | "source", boolean>;
type WebsiteAccess = { siteId: string; userId: string; role: MemberRole | null; capabilities: WebsiteCapabilities };
type MembershipResponse = WebsiteAccess & { members: Member[]; assignableRoles: MemberRole[] };
const ROLES: Record<MemberRole, { name: string; description: string }> = {
  VIEWER: { name: "Viewer", description: "Open pages, drafts and version history." },
  EDITOR: { name: "Editor", description: "Edit content and save drafts. Publishing needs a publisher." },
  REVIEWER: { name: "Reviewer", description: "Inspect drafts and publication reviews." },
  PUBLISHER: { name: "Publisher", description: "Review and publish saved drafts and versions." },
  MANAGER: { name: "Manager", description: "Manage members, site settings, content and publishing." },
  DEVELOPER: { name: "Developer", description: "Edit, publish and manage source settings. Member access stays with managers." },
};
const inputClass = "h-10 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink";

/** Server-owned capabilities are scoped to the selected site, never guessed from OS roles. */
export function useWebsiteAccess(siteId?: string) {
  return useQuery({
    queryKey: ["website", "access", siteId], enabled: Boolean(siteId),
    queryFn: () => api.get<WebsiteAccess>(`/website/sites/${encodeURIComponent(siteId!)}/access`),
    staleTime: 15_000,
  });
}

export function WebsiteMembers({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const access = useWebsiteAccess(siteId);
  const members = useQuery({ queryKey: ["website", "members", siteId], enabled: access.data?.capabilities.members === true, queryFn: () => api.get<MembershipResponse>(`/website/sites/${encodeURIComponent(siteId)}/members`) });
  const [identity, setIdentity] = useState("");
  const [identityType, setIdentityType] = useState<"email" | "userId">("email");
  const [role, setRole] = useState<MemberRole>("VIEWER");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const refresh = async () => { await qc.invalidateQueries({ queryKey: ["website"] }); };
  const add = useMutation({ mutationFn: () => api.post(`/website/sites/${encodeURIComponent(siteId)}/members`, { [identityType]: identity.trim(), role }), onSuccess: async () => { setIdentity(""); setNotice("Website access added."); await refresh(); } });
  const update = useMutation({ mutationFn: ({ id, nextRole }: { id: string; nextRole: MemberRole }) => api.patch(`/website/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(id)}`, { role: nextRole }), onSuccess: async () => { setNotice("Website role updated."); await refresh(); } });
  const remove = useMutation({ mutationFn: (id: string) => api.delete(`/website/sites/${encodeURIComponent(siteId)}/members/${encodeURIComponent(id)}`), onSuccess: async () => { setRemoving(null); setNotice("Website access removed."); await refresh(); } });
  const busy = add.isPending || update.isPending || remove.isPending;
  const error = access.error || members.error || add.error || update.error || remove.error;
  const resetFeedback = () => { setNotice(""); add.reset(); update.reset(); remove.reset(); };
  const canManage = access.data?.capabilities.members === true;
  const managerCount = members.data?.members.filter(member => member.role === "MANAGER" && member.user.active).length ?? 0;

  return <div className="max-w-4xl space-y-6">
    {(access.isLoading || members.isLoading && canManage) && <p className="text-sm text-muted" role="status">Loading website access…</p>}
    {error && <p role="alert" className="rounded-xl border border-danger-line bg-danger-surface p-3 text-sm text-danger-text">{(error as Error).message}</p>}
    {notice && <p role="status" className="text-sm text-muted">{notice}</p>}
    {access.data && !canManage && <div className="rounded-2xl border border-line bg-white p-5"><h2 className="font-display text-lg">Your website access</h2><p className="mt-2 text-sm text-muted">{access.data.role ? `${ROLES[access.data.role].name}: ${ROLES[access.data.role].description}` : "Your account's staff permissions provide access to this site."}</p><p className="mt-3 text-sm text-muted">A website manager can change who has access.</p></div>}
    {canManage && members.data && <>
      <form className="rounded-2xl border border-line bg-white p-5" onSubmit={event => { event.preventDefault(); resetFeedback(); add.mutate(); }}>
        <h2 className="font-display text-lg">Add an account to this website</h2>
        <p className="mt-1 text-sm text-muted">Use an existing account. This changes access immediately and sends no invitation email.</p>
        <div className="mt-5 grid items-end gap-3 sm:grid-cols-[130px_1fr_170px]">
          <label className="text-xs text-muted">Find by<select className={`${inputClass} mt-1`} disabled={busy} value={identityType} onChange={event => { setIdentityType(event.target.value as "email" | "userId"); setIdentity(""); resetFeedback(); }}><option value="email">Email</option><option value="userId">User ID</option></select></label>
          <label className="text-xs text-muted">{identityType === "email" ? "Account email" : "Account user ID"}<input className={`${inputClass} mt-1`} required maxLength={identityType === "email" ? 254 : 100} type={identityType === "email" ? "email" : "text"} autoComplete="off" disabled={busy} value={identity} onChange={event => { setIdentity(event.target.value); resetFeedback(); }} placeholder={identityType === "email" ? "person@example.com" : "User ID"} /></label>
          <label className="text-xs text-muted">Website role<select className={`${inputClass} mt-1`} disabled={busy} value={role} onChange={event => setRole(event.target.value as MemberRole)}>{members.data.assignableRoles.map(option => <option key={option} value={option}>{ROLES[option].name}</option>)}</select></label>
        </div>
        <p className="my-3 text-xs text-muted">{ROLES[role].description}</p>
        <Button type="submit" disabled={busy || !identity.trim() || !members.data.assignableRoles.includes(role)}>{add.isPending ? "Adding…" : "Add website access"}</Button>
      </form>
      <section className="overflow-hidden rounded-2xl border border-line bg-white">
        <div className="border-b border-line p-5"><h2 className="font-display text-lg">Website members</h2><p className="mt-1 text-xs text-muted">Website roles apply only here. Staff may also have access through their internal account permissions.</p></div>
        {members.data.members.length === 0 && <p className="p-5 text-sm text-muted">No site members yet. Add a manager to let them administer this website.</p>}
        <ul className="divide-y divide-line">{members.data.members.map(member => {
          const lastManager = member.role === "MANAGER" && member.user.active && managerCount <= 1;
          const editable = members.data!.assignableRoles.includes(member.role);
          return <li key={member.id} className="flex flex-wrap items-center gap-4 p-5">
            <div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{member.user.name}{member.user.id === access.data?.userId && <span className="ml-2 text-xs font-normal text-muted">You</span>}{!member.user.active && <span className="ml-2 text-xs text-muted">Inactive account</span>}</p><p className="mt-1 break-all text-xs text-muted">{member.user.email}</p>{lastManager && <p className="mt-1 text-xs text-muted">Last active manager — add another manager before changing this role.</p>}</div>
            <label className="w-40 text-xs text-muted"><span className="sr-only">Role for {member.user.name}</span><select className={inputClass} disabled={busy || lastManager || !editable} value={member.role} onChange={event => { resetFeedback(); update.mutate({ id: member.id, nextRole: event.target.value as MemberRole }); }}>{Array.from(new Set([member.role, ...members.data!.assignableRoles])).map(option => <option key={option} value={option}>{ROLES[option].name}</option>)}</select></label>
            <Button variant="secondary" size="sm" disabled={busy || lastManager || !editable} onClick={() => { resetFeedback(); setRemoving(member); }}>Remove</Button>
          </li>;
        })}</ul>
      </section>
      {removing && <div className="rounded-2xl border border-line bg-sunken p-5" role="group" aria-label="Confirm removal"><p className="text-sm">Remove <strong>{removing.user.name}</strong> from this website? Their account and existing work will remain.</p><div className="mt-4 flex gap-3"><Button disabled={busy} onClick={() => { resetFeedback(); remove.mutate(removing.id); }}>{remove.isPending ? "Removing…" : "Remove website access"}</Button><Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button></div></div>}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{Object.entries(ROLES).map(([key, value]) => <article key={key} className="rounded-xl border border-line p-4"><h3 className="text-sm font-semibold">{value.name}</h3><p className="mt-1 text-xs leading-relaxed text-muted">{value.description}</p></article>)}</div>
    </>}
  </div>;
}

export function WebsiteTeam() {
  const sites = useQuery({ queryKey: ["website", "sites"], queryFn: () => api.get<SiteSummary[]>("/website/sites") });
  const [selected, setSelected] = useState("");
  const id = sites.data?.some(site => site.id === selected) ? selected : sites.data?.[0]?.id;
  return <div><PageHeader title="Website team" subtitle="Give each person the access they need on each website." />
    {sites.error && <p role="alert" className="text-sm text-danger-text">{(sites.error as Error).message}</p>}
    {sites.isLoading && <p role="status" className="text-sm text-muted">Loading websites…</p>}
    {sites.data?.length === 0 && <p className="text-sm text-muted">Your websites will appear here once access is assigned.</p>}
    {id && <><label className="mb-6 block max-w-md text-xs text-muted">Website<select className={`${inputClass} mt-1`} value={id} onChange={event => setSelected(event.target.value)}>{sites.data?.map(site => <option key={site.id} value={site.id}>{site.name}</option>)}</select></label><WebsiteMembers key={id} siteId={id} /></>}
  </div>;
}
