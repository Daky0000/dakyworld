import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Badge, Button, Card, Field, Notice } from "./ui";

/**
 * Who belongs to a client, and so what its retainer reaches.
 *
 * A retainer is the client's. Everybody listed here gets every DakyX product
 * with it — the Website Builder here and the Marketing SaaS at
 * marketing.dakyx.com — and loses it the moment they are removed or the
 * retainer stops. Comps are the exceptions: a product given by hand, with a
 * reason and, usually, an end date. See docs/cross-product-access.md.
 */

type Grant = { product: string; tier: string; source: string; validUntil: string | null };
type Comp = { id: string; productKey: string; tier: string; reason: string; validUntil: string | null };
type Member = {
  id: string;
  userId: string;
  role: "OWNER" | "MEMBER";
  user: { id: string; name: string; email: string };
  grants: Grant[];
  comps: Comp[];
};
type Response = { members: Member[]; productTiers: Record<string, string[]> };

const PRODUCT_NAMES: Record<string, string> = { "website-builder": "Website Builder", "marketing-suite": "Marketing" };
const SOURCE_NAMES: Record<string, string> = { retainer: "retainer", subscription: "own plan", staff: "staff", comp: "comp" };

export function ClientPeople({ clientId }: { clientId: string }) {
  const queryClient = useQueryClient();
  const key = ["clients", clientId, "members"];
  const people = useQuery({ queryKey: key, queryFn: ({ signal }) => api.get<Response>(`/clients/${clientId}/members`, signal) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const add = useMutation({
    mutationFn: () => api.post<{ created: boolean }>(`/clients/${clientId}/members`, { email, name: name || undefined }),
    onSuccess: () => { setEmail(""); setName(""); void refresh(); },
  });
  const remove = useMutation({ mutationFn: (userId: string) => api.delete(`/clients/${clientId}/members/${userId}`), onSuccess: refresh });
  const revoke = useMutation({ mutationFn: (grantId: string) => api.delete(`/clients/${clientId}/grants/${grantId}`), onSuccess: refresh });

  const [comping, setComping] = useState<string | null>(null);
  const [comp, setComp] = useState({ productKey: "marketing-suite", tier: "starter", reason: "", validUntil: "" });
  const give = useMutation({
    mutationFn: (userId: string) => api.post(`/clients/${clientId}/grants`, { userId, ...comp, validUntil: comp.validUntil || null }),
    onSuccess: () => { setComping(null); setComp({ productKey: "marketing-suite", tier: "starter", reason: "", validUntil: "" }); void refresh(); },
  });

  const tiers = people.data?.productTiers ?? {};

  return (
    <div className="space-y-3">
      <div>
        <h3 className="font-display text-base font-medium text-ink">People with access</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          Everyone here gets every DakyX product this client's retainer includes, in the builder and in Marketing. Remove someone and it stops.
        </p>
      </div>

      {people.isError && <Notice tone="danger">{(people.error as Error).message}</Notice>}

      <div className="space-y-2.5">
        {people.data?.members.map((member) => (
          <Card key={member.id} className="space-y-2.5 p-3.5">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate font-display text-xs font-medium text-ink">{member.user.name}</div>
                <div className="truncate text-xs text-muted">{member.user.email}</div>
              </div>
              <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate(member.userId)}>Remove</Button>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {member.grants.length === 0 && <Badge tone="muted">No products</Badge>}
              {member.grants.map((grant) => (
                <Badge key={grant.product} tone={grant.source === "retainer" ? "positive" : "info"}>
                  {PRODUCT_NAMES[grant.product] ?? grant.product}: {grant.tier} · {SOURCE_NAMES[grant.source] ?? grant.source}
                </Badge>
              ))}
            </div>

            {member.comps.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-2 text-xs text-muted">
                <span>
                  Comp: {PRODUCT_NAMES[c.productKey] ?? c.productKey} {c.tier}
                  {c.validUntil ? ` until ${new Date(c.validUntil).toLocaleDateString()}` : ""} — {c.reason}
                </span>
                <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate(c.id)}>Revoke</Button>
              </div>
            ))}

            {comping === member.userId ? (
              <form
                className="grid gap-2 sm:grid-cols-2"
                onSubmit={(event) => { event.preventDefault(); give.mutate(member.userId); }}
              >
                <Field label="Product">
                  <select
                    className="input"
                    value={comp.productKey}
                    onChange={(event) => setComp({ ...comp, productKey: event.target.value, tier: tiers[event.target.value]?.[0] ?? "" })}
                  >
                    {Object.keys(tiers).map((product) => <option key={product} value={product}>{PRODUCT_NAMES[product] ?? product}</option>)}
                  </select>
                </Field>
                <Field label="Tier">
                  <select className="input" value={comp.tier} onChange={(event) => setComp({ ...comp, tier: event.target.value })}>
                    {(tiers[comp.productKey] ?? []).map((tier) => <option key={tier} value={tier}>{tier}</option>)}
                  </select>
                </Field>
                <Field label="Why" full>
                  <input className="input" required minLength={3} value={comp.reason} onChange={(event) => setComp({ ...comp, reason: event.target.value })} placeholder="Trial while we set up their campaigns" />
                </Field>
                <Field label="Ends" hint="Leave empty for no end date.">
                  <input className="input" type="date" value={comp.validUntil} onChange={(event) => setComp({ ...comp, validUntil: event.target.value })} />
                </Field>
                <div className="flex items-end gap-2">
                  <Button size="sm" type="submit" disabled={give.isPending}>Give access</Button>
                  <Button size="sm" variant="ghost" onClick={() => setComping(null)}>Cancel</Button>
                </div>
                {give.isError && <div className="sm:col-span-2"><Notice tone="danger">{(give.error as Error).message}</Notice></div>}
              </form>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => setComping(member.userId)}>Give a product without a retainer</Button>
            )}
          </Card>
        ))}
        {people.data && people.data.members.length === 0 && (
          <div className="rounded-xl border border-dashed border-line p-5 text-center text-xs text-muted">
            Nobody is linked to this client yet, so their retainer reaches nobody.
          </div>
        )}
      </div>

      <form
        className="space-y-2"
        onSubmit={(event) => { event.preventDefault(); add.mutate(); }}
      >
        <Field label="Add by email" hint="A new address gets an account and an email to set its password.">
          <input className="input" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="ama@theirbusiness.com" />
        </Field>
        <Field label="Name (optional)">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Button size="sm" type="submit" disabled={add.isPending || !email}>Add person</Button>
        {add.isError && <Notice tone="danger">{(add.error as Error).message}</Notice>}
      </form>
    </div>
  );
}
