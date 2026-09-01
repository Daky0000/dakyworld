import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, Drawer, EmptyState, Field, PageHeader, Table } from "../components/ui";

/**
 * Who has an account, and what each of them is allowed to do.
 *
 * Access used to be six values in a Prisma enum and twenty `requireRole` lines
 * across the API. Changing what a Project Manager could reach meant editing
 * TypeScript and waiting for a deploy, and there was no screen for any of it —
 * the endpoints to invite somebody and set their role existed and nothing in
 * this client had ever called them.
 *
 * Two tabs, because they are two different decisions with two different blast
 * radii. **People** puts one person on a role and adjusts them individually;
 * it affects one person. **Roles** decides what a role contains; it affects
 * everybody on it at once, which is why the two sit behind different
 * permissions.
 *
 * The rule that shapes the whole screen: **a role starts empty.** Naming a role
 * is not the same as deciding what it can reach, and one that arrived
 * pre-filled would make every new role a question of what to take away rather
 * than what to give.
 */

type Permission = {
  key: string;
  label: string;
  description: string;
  spends?: boolean;
  external?: boolean;
};

type PermissionModule = {
  key: string;
  label: string;
  description: string;
  permissions: Permission[];
};

type Role = {
  id: string;
  key: string;
  name: string;
  description: string | null;
  system: boolean;
  superAdmin: boolean;
  external: boolean;
  permissions: string[];
  userCount: number;
};

type Member = {
  id: string;
  name: string;
  email: string;
  active: boolean;
  skills: string[];
  weeklyCapacityHours: string | number;
  createdAt: string;
  twoFactorEnabled: boolean;
  canSignIn: boolean;
  extraPermissions: string[];
  deniedPermissions: string[];
  effectivePermissions: string[];
  accessRole: Pick<Role, "id" | "key" | "name" | "system" | "superAdmin" | "external" | "permissions"> | null;
};

export function Team() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "roles" ? "roles" : "people";
  const setTab = (next: "people" | "roles") => setParams(next === "people" ? {} : { tab: next });
  const { can } = useAuth();

  return (
    <>
      <PageHeader
        eyebrow="Team & Access"
        title="Who can do what"
        subtitle="Put somebody on a role, then add or remove individual features for them."
      />

      <div className="mb-6 flex gap-1.5">
        {([
          ["people", "People"],
          ["roles", "Roles"],
        ] as const).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold transition ${
              tab === value ? "bg-ink text-white" : "text-muted hover:bg-sunken hover:text-ink"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "people" ? <People /> : <Roles canManage={can("team.roles")} />}
    </>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function People() {
  const qc = useQueryClient();
  const { can, user: me } = useAuth();
  const [open, setOpen] = useState<string | null>(null);
  const [inviting, setInviting] = useState(false);

  const members = useQuery({ queryKey: ["team", "members"], queryFn: () => api.get<Member[]>("/users/manage") });
  const roles = useQuery({ queryKey: ["team", "roles"], queryFn: () => api.get<Role[]>("/access/roles") });

  const selected = members.data?.find((m) => m.id === open) ?? null;

  if (members.isLoading) return <p className="text-sm text-muted">Loading the team…</p>;

  return (
    <>
      <div className="mb-4 flex justify-end">
        {can("team.invite") && (
          <Button variant="accent" onClick={() => setInviting(true)}>
            Add someone
          </Button>
        )}
      </div>

      {members.data?.length === 0 ? (
        <EmptyState message="Nobody has an account yet." />
      ) : (
        <Table>
          <thead>
            <tr className="border-b border-line font-mono text-[10px] uppercase tracking-[.12em] text-muted">
              <th className="px-4 py-3 font-mono font-normal">Person</th>
              <th className="px-4 py-3 font-mono font-normal">Role</th>
              <th className="px-4 py-3 font-mono font-normal">Features</th>
              <th className="px-4 py-3 font-mono font-normal">Sign-in</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {members.data?.map((member) => (
              <tr key={member.id} className="border-b border-line/70 last:border-0">
                <td className="px-4 py-3">
                  <div className="font-semibold">
                    {member.name}
                    {member.id === me?.id && <span className="ml-2 text-[11px] font-normal text-muted">you</span>}
                  </div>
                  <div className="text-xs text-muted">{member.email}</div>
                </td>
                <td className="px-4 py-3">
                  {member.accessRole ? (
                    <Badge tone={member.accessRole.superAdmin ? "positive" : "default"}>{member.accessRole.name}</Badge>
                  ) : (
                    // The honest rendering of a null role. It is not a missing
                    // value to be filled in with a sensible default — it is an
                    // account that can sign in and reach nothing, which is
                    // exactly what a new account should be until somebody
                    // decides otherwise.
                    <Badge tone="warn">No role — no access</Badge>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted">
                  {member.accessRole?.superAdmin ? (
                    "Everything"
                  ) : (
                    <>
                      {member.effectivePermissions.length}
                      {member.extraPermissions.length > 0 && <span className="text-blue"> +{member.extraPermissions.length}</span>}
                      {member.deniedPermissions.length > 0 && (
                        <span className="text-warn-text"> −{member.deniedPermissions.length}</span>
                      )}
                    </>
                  )}
                </td>
                <td className="px-4 py-3 text-xs">
                  {!member.active ? (
                    <Badge tone="muted">Switched off</Badge>
                  ) : !member.canSignIn ? (
                    <span className="text-muted" title="No password set — they appear in dropdowns but cannot log in.">
                      No password
                    </span>
                  ) : (
                    <span className="text-muted">{member.twoFactorEnabled ? "Password + 2FA" : "Password"}</span>
                  )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Button size="sm" variant="secondary" onClick={() => setOpen(member.id)}>
                    Open
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {selected && (
        <MemberDrawer
          member={selected}
          roles={roles.data ?? []}
          isSelf={selected.id === me?.id}
          onClose={() => setOpen(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["team"] })}
        />
      )}

      {inviting && (
        <InviteDrawer
          roles={roles.data ?? []}
          onClose={() => setInviting(false)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["team"] })}
        />
      )}
    </>
  );
}

function MemberDrawer({
  member,
  roles,
  isSelf,
  onClose,
  onSaved,
}: {
  member: Member;
  roles: Role[];
  isSelf: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { can } = useAuth();
  const [roleId, setRoleId] = useState(member.accessRole?.id ?? "");
  const [extra, setExtra] = useState<string[]>(member.extraPermissions);
  const [denied, setDenied] = useState<string[]>(member.deniedPermissions);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");

  const role = roles.find((r) => r.id === roleId) ?? null;
  const catalogue = usePermissionCatalogue();

  const saveAccess = useMutation({
    mutationFn: () =>
      api.patch(`/users/${member.id}/access`, {
        accessRoleId: roleId || null,
        extraPermissions: extra,
        deniedPermissions: denied,
      }),
    onSuccess: () => {
      setError(null);
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not save that."),
  });

  const setPasswordFor = useMutation({
    mutationFn: () => api.patch(`/users/${member.id}/password`, { password }),
    onSuccess: () => {
      setPassword("");
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not set that password."),
  });

  const toggleActive = useMutation({
    mutationFn: () => api.patch(`/users/${member.id}/active`, { active: !member.active }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not change that."),
  });

  const clear2fa = useMutation({
    mutationFn: () => api.delete(`/users/${member.id}/2fa`),
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not reset that."),
  });

  /**
   * What a tick means here depends on where the permission came from.
   *
   * Three states, not two: the role gives it, this person has been given it on
   * top, or this person has had it taken away. Collapsing that into one
   * checkbox would lose the difference between "they have this because they're
   * a Project Manager" and "they have this because I gave it to them", and the
   * first changes when the role changes while the second does not.
   */
  const stateOf = (key: string): "role" | "extra" | "denied" | "none" => {
    if (denied.includes(key)) return "denied";
    if (extra.includes(key)) return "extra";
    if (role?.permissions.includes(key)) return "role";
    return "none";
  };

  const cycle = (key: string) => {
    const fromRole = role?.permissions.includes(key) ?? false;
    const state = stateOf(key);
    setError(null);
    if (fromRole) {
      // On → off is a denial; off → on removes the denial.
      setDenied(state === "denied" ? denied.filter((k) => k !== key) : [...denied, key]);
    } else {
      setExtra(state === "extra" ? extra.filter((k) => k !== key) : [...extra, key]);
      setDenied(denied.filter((k) => k !== key));
    }
  };

  const dirty =
    roleId !== (member.accessRole?.id ?? "") ||
    extra.join() !== member.extraPermissions.join() ||
    denied.join() !== member.deniedPermissions.join();

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={member.name}
      subtitle={member.email}
      footer={
        can("team.access") && !isSelf ? (
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted">
              {dirty ? "Saving signs them out, so the change takes effect immediately." : "No changes."}
            </span>
            <Button variant="accent" disabled={!dirty || saveAccess.isPending} onClick={() => saveAccess.mutate()}>
              {saveAccess.isPending ? "Saving…" : "Save access"}
            </Button>
          </div>
        ) : null
      }
    >
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          {error}
        </p>
      )}

      {isSelf && (
        <p className="mb-5 rounded-xl border border-warn-line bg-warn-surface px-3.5 py-2.5 text-[13px] text-warn-text">
          This is your own account. Nobody can change their own access — an Owner who ticks the wrong box on themselves is
          locked out of the screen that would undo it. Ask another Owner.
        </p>
      )}

      {can("team.access") && !isSelf && (
        <section className="mb-7">
          <Field label="Role" hint="What they get by default. Everything below is on top of this.">
            <select
              value={roleId}
              onChange={(event) => setRoleId(event.target.value)}
              className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm"
            >
              <option value="">No role — no access at all</option>
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                  {r.superAdmin ? " (everything)" : ` (${r.permissions.length} features)`}
                </option>
              ))}
            </select>
          </Field>
          {role?.description && <p className="mt-2 text-xs text-muted">{role.description}</p>}
        </section>
      )}

      {role?.superAdmin ? (
        <Card className="bg-sunken">
          <p className="text-[13px] text-muted">
            The Owner role has every feature and always will — that is what makes it impossible to lock everybody out of
            this screen. There is nothing to tick.
          </p>
        </Card>
      ) : (
        can("team.access") &&
        !isSelf && (
          <section className="mb-7">
            <h2 className="mb-1 font-display text-lg tracking-[-.02em]">Features</h2>
            <p className="mb-4 text-xs text-muted">
              Filled squares come from the role. Click one to take it away from this person only; click an empty one to
              give it to them on top of their role.
            </p>
            <PermissionMatrix modules={catalogue.data ?? []} stateOf={stateOf} onToggle={cycle} />
          </section>
        )
      )}

      <section className="border-t border-line pt-6">
        <h2 className="mb-4 font-display text-lg tracking-[-.02em]">Account</h2>
        <div className="space-y-4">
          {can("team.password") && (
            <div>
              <Field label="Set a password" hint="Ends every session they hold. Pass it on out of band — there is no invitation email.">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    placeholder="At least 10 characters"
                    className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm"
                  />
                  <Button
                    variant="secondary"
                    disabled={password.length < 1 || setPasswordFor.isPending}
                    onClick={() => setPasswordFor.mutate()}
                  >
                    Set
                  </Button>
                </div>
              </Field>
            </div>
          )}

          {can("team.twofactor") && member.twoFactorEnabled && (
            <div className="flex items-center justify-between gap-4">
              <div className="text-[13px]">
                <div className="font-semibold">Two-factor is on</div>
                <div className="text-xs text-muted">Clear it if their phone is gone. Their sessions go with it.</div>
              </div>
              <Button variant="secondary" disabled={clear2fa.isPending} onClick={() => clear2fa.mutate()}>
                Reset 2FA
              </Button>
            </div>
          )}

          {can("team.deactivate") && !isSelf && (
            <div className="flex items-center justify-between gap-4">
              <div className="text-[13px]">
                <div className="font-semibold">{member.active ? "Account is active" : "Account is switched off"}</div>
                <div className="text-xs text-muted">
                  Switching off rather than deleting — a deleted person takes their name off every task and email they
                  ever touched.
                </div>
              </div>
              <Button
                variant={member.active ? "danger" : "secondary"}
                disabled={toggleActive.isPending}
                onClick={() => toggleActive.mutate()}
              >
                {member.active ? "Switch off" : "Switch back on"}
              </Button>
            </div>
          )}
        </div>
      </section>
    </Drawer>
  );
}

function InviteDrawer({ roles, onClose, onSaved }: { roles: Role[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [roleId, setRoleId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post("/users", { name, email, password: password || undefined, accessRoleId: roleId || undefined }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not create that account."),
  });

  return (
    <Drawer
      open
      onClose={onClose}
      title="Add someone"
      subtitle="They can be given a role now or later."
      footer={
        <div className="flex justify-end">
          <Button variant="accent" disabled={!name || !email || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Creating…" : "Create account"}
          </Button>
        </div>
      }
    >
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          {error}
        </p>
      )}
      <div className="space-y-4">
        <Field label="Name">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field
          label="Password"
          hint="Optional. Without one they appear in assignment dropdowns but cannot sign in."
        >
          <input
            type="text"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm"
          />
        </Field>
        <Field label="Role" hint="Leave this empty and they will have no access until you give them one.">
          <select
            value={roleId}
            onChange={(event) => setRoleId(event.target.value)}
            className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm"
          >
            <option value="">No role yet</option>
            {roles
              .filter((r) => !r.superAdmin)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
          </select>
        </Field>
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function Roles({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const open = params.get("role");
  const setOpen = (id: string | null) => setParams(id ? { tab: "roles", role: id } : { tab: "roles" });
  const [creating, setCreating] = useState(false);

  const roles = useQuery({ queryKey: ["team", "roles"], queryFn: () => api.get<Role[]>("/access/roles") });
  const selected = roles.data?.find((r) => r.id === open) ?? null;

  if (roles.isLoading) return <p className="text-sm text-muted">Loading roles…</p>;

  return (
    <>
      <div className="mb-4 flex justify-end">
        {canManage && (
          <Button variant="accent" onClick={() => setCreating(true)}>
            New role
          </Button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {roles.data?.map((role) => (
          <Card key={role.id} className="flex flex-col justify-between">
            <div>
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-display text-lg tracking-[-.02em]">{role.name}</h3>
                <div className="flex shrink-0 gap-1.5">
                  {role.system && <Badge tone="muted">Built in</Badge>}
                  {role.external && <Badge tone="warn">Outside the company</Badge>}
                </div>
              </div>
              {role.description && <p className="mt-2 text-[13px] leading-relaxed text-muted">{role.description}</p>}
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3">
              <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                {role.superAdmin ? "Every feature" : `${role.permissions.length} features`} ·{" "}
                {role.userCount === 1 ? "1 person" : `${role.userCount} people`}
              </span>
              <Button size="sm" variant="secondary" onClick={() => setOpen(role.id)}>
                {canManage && !role.superAdmin ? "Edit" : "View"}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {selected && (
        <RoleDrawer
          role={selected}
          canManage={canManage}
          onClose={() => setOpen(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["team"] })}
        />
      )}

      {creating && (
        <RoleDrawer
          canManage={canManage}
          onClose={() => setCreating(false)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ["team"] })}
        />
      )}
    </>
  );
}

function RoleDrawer({
  role,
  canManage,
  onClose,
  onSaved,
}: {
  role?: Role;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<string[]>(role?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);

  const catalogue = usePermissionCatalogue();
  const editable = canManage && !role?.superAdmin;

  const save = useMutation({
    mutationFn: () =>
      role
        ? api.patch(`/access/roles/${role.id}`, { name, description: description || null, permissions })
        : api.post("/access/roles", { name, description: description || null, permissions }),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not save that role."),
  });

  const remove = useMutation({
    mutationFn: () => api.delete(`/access/roles/${role!.id}`),
    onSuccess: () => {
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : "Could not delete that role."),
  });

  const toggle = (key: string) => {
    setError(null);
    setPermissions(permissions.includes(key) ? permissions.filter((k) => k !== key) : [...permissions, key]);
  };

  const toggleModule = (module: PermissionModule) => {
    const keys = module.permissions.map((p) => p.key);
    const allOn = keys.every((key) => permissions.includes(key));
    setPermissions(allOn ? permissions.filter((key) => !keys.includes(key)) : [...new Set([...permissions, ...keys])]);
  };

  return (
    <Drawer
      open
      wide
      onClose={onClose}
      title={role ? role.name : "New role"}
      subtitle={
        role?.superAdmin
          ? "Always has everything. This is what makes a lockout impossible."
          : role
            ? `${role.userCount === 1 ? "1 person is" : `${role.userCount} people are`} on this role`
            : "It starts with nothing ticked. Give it only what the job needs."
      }
      footer={
        editable ? (
          <div className="flex items-center justify-between gap-3">
            {role && !role.system ? (
              <Button variant="danger" size="sm" disabled={remove.isPending} onClick={() => remove.mutate()}>
                Delete role
              </Button>
            ) : (
              <span />
            )}
            <Button variant="accent" disabled={!name || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : role ? "Save role" : "Create role"}
            </Button>
          </div>
        ) : null
      }
    >
      {error && (
        <p role="alert" className="mb-4 rounded-xl border border-danger-line bg-danger-surface px-3.5 py-2.5 text-sm text-danger-text">
          {error}
        </p>
      )}

      {role?.superAdmin ? (
        <Card className="bg-sunken">
          <p className="text-[13px] leading-relaxed text-muted">
            The Owner role answers every permission check without reading a list, so there is nothing here to edit.
            That is deliberate: every other role can be narrowed to nothing safely, because there is always one that
            does not read the ticks.
          </p>
        </Card>
      ) : (
        <>
          {editable && (
            <div className="mb-6 space-y-4">
              <Field label="Name">
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={role?.system}
                  placeholder="Lead"
                  className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm disabled:bg-sunken disabled:text-muted"
                />
              </Field>
              <Field label="What this role is for" hint={role?.system ? "Built-in roles keep their shipped name and description." : undefined}>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  disabled={role?.system}
                  placeholder="Runs a delivery team. Sees the work, not the money."
                  className="w-full rounded-xl border border-line bg-white px-3 py-2 text-sm disabled:bg-sunken disabled:text-muted"
                />
              </Field>
            </div>
          )}

          <h2 className="mb-1 font-display text-lg tracking-[-.02em]">Features</h2>
          <p className="mb-4 text-xs text-muted">
            {permissions.length} of {catalogue.data?.reduce((n, m) => n + m.permissions.length, 0) ?? 0} ticked.
          </p>
          <PermissionMatrix
            modules={catalogue.data ?? []}
            stateOf={(key) => (permissions.includes(key) ? "role" : "none")}
            onToggle={editable ? toggle : undefined}
            onToggleModule={editable ? toggleModule : undefined}
          />
        </>
      )}
    </Drawer>
  );
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

function usePermissionCatalogue() {
  return useQuery({
    queryKey: ["team", "permissions"],
    queryFn: () => api.get<PermissionModule[]>("/access/permissions"),
    // The catalogue only changes when the app is redeployed.
    staleTime: Infinity,
  });
}

function PermissionMatrix({
  modules,
  stateOf,
  onToggle,
  onToggleModule,
}: {
  modules: PermissionModule[];
  stateOf: (key: string) => "role" | "extra" | "denied" | "none";
  onToggle?: (key: string) => void;
  onToggleModule?: (module: PermissionModule) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const counts = useMemo(
    () =>
      Object.fromEntries(
        modules.map((module) => [
          module.key,
          module.permissions.filter((p) => stateOf(p.key) === "role" || stateOf(p.key) === "extra").length,
        ]),
      ),
    [modules, stateOf],
  );

  return (
    <div className="space-y-2">
      {modules.map((module) => {
        const isCollapsed = collapsed[module.key] ?? counts[module.key] === 0;
        return (
          <div key={module.key} className="overflow-hidden rounded-2xl border border-line">
            <div className="flex items-center justify-between gap-3 bg-sunken px-4 py-3">
              <button
                type="button"
                onClick={() => setCollapsed({ ...collapsed, [module.key]: !isCollapsed })}
                className="flex items-center gap-2 text-left"
              >
                <span aria-hidden className={`text-[9px] text-muted transition ${isCollapsed ? "" : "rotate-90"}`}>
                  ▶
                </span>
                <span className="text-[13px] font-bold">{module.label}</span>
                <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted">
                  {counts[module.key]}/{module.permissions.length}
                </span>
              </button>
              {onToggleModule && (
                <button
                  type="button"
                  onClick={() => onToggleModule(module)}
                  className="text-[11px] font-semibold text-blue hover:underline"
                >
                  {counts[module.key] === module.permissions.length ? "None" : "All"}
                </button>
              )}
            </div>

            {!isCollapsed && (
              <div className="divide-y divide-line/70">
                {module.permissions.map((permission) => {
                  const state = stateOf(permission.key);
                  const on = state === "role" || state === "extra";
                  return (
                    <button
                      key={permission.key}
                      type="button"
                      disabled={!onToggle}
                      onClick={() => onToggle?.(permission.key)}
                      className="flex w-full items-start gap-3 px-4 py-3 text-left transition disabled:cursor-default hover:bg-sunken disabled:hover:bg-transparent"
                    >
                      <span
                        aria-hidden
                        className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded text-[10px] leading-none ${
                          state === "denied"
                            ? "bg-warn-surface text-warn-text"
                            : state === "extra"
                              ? "bg-blue text-white"
                              : on
                                ? "bg-ink text-white"
                                : "border border-line-strong"
                        }`}
                      >
                        {state === "denied" ? "−" : on ? "✓" : ""}
                      </span>
                      <span className="min-w-0">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="text-[13px] font-semibold">{permission.label}</span>
                          {/* Money and reach are the two things worth pausing over, so
                              they are marked rather than left in the description. */}
                          {permission.spends && <Badge tone="warn">Spends money</Badge>}
                          {permission.external && <Badge tone="warn">Leaves the company</Badge>}
                          {state === "extra" && <Badge tone="default">Added for this person</Badge>}
                          {state === "denied" && <Badge tone="muted">Taken away</Badge>}
                        </span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted">{permission.description}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
