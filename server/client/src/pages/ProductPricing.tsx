import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Badge, Button, RelativeTime } from "../components/ui";

/**
 * What a product costs somebody who is not on a retainer.
 *
 * The rule above the table is the product, not a note about it: a client on an
 * active retainer gets everything here at no charge, and these numbers are for
 * everyone else. Stating it on the screen where the prices are edited is the
 * cheapest way to stop somebody quoting a retainer client for a product they
 * already have.
 *
 * What is edited here is what dakyworld.com shows. The public pages read the
 * same rows through `/api/public/products`, so a change reaches the website on
 * its next load — no deploy, and no second copy of the number to forget.
 */

type Product = {
  key: string;
  name: string;
  tagline: string;
  currency: string;
  monthlyPrice: string;
  setupPrice: string | null;
  publicPath: string;
  active: boolean;
  updatedAt: string;
  updatedBy: { id: string; name: string } | null;
};

const INPUT = "h-9 w-full rounded-xl border border-line bg-white px-3 text-sm text-ink outline-none focus:border-blue focus:ring-2 focus:ring-blue/20 disabled:bg-cream";

export function ProductPricing() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const mayEdit = can("website.manage");

  const catalogue = useQuery({
    queryKey: ["products"],
    queryFn: () => api.get<{ products: Product[]; includedWithRetainer: string }>("/products"),
  });

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl tracking-[-.02em]">Product pricing</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          What dakyworld.com asks for each product. The website reads these rows directly, so a change here is on the public page the
          next time somebody loads it.
        </p>
      </div>

      {catalogue.data && (
        <p className="rounded-2xl border border-positive-line bg-positive-surface px-4 py-3 text-sm text-positive-text">
          {catalogue.data.includedWithRetainer}
        </p>
      )}

      {catalogue.isLoading && <p className="text-sm text-muted">Reading the catalogue…</p>}
      {catalogue.isError && (
        <p className="rounded-2xl border border-warn-line bg-warn-surface p-4 text-sm text-warn-text">
          {catalogue.error instanceof ApiError ? catalogue.error.message : "The catalogue could not be read."}
        </p>
      )}

      {catalogue.data?.products.map((product) => (
        <ProductRow key={product.key} product={product} mayEdit={mayEdit} onSaved={() => void qc.invalidateQueries({ queryKey: ["products"] })} />
      ))}

      {catalogue.data?.products.length === 0 && <p className="text-sm text-muted">No products yet.</p>}
    </div>
  );
}

function ProductRow({ product, mayEdit, onSaved }: { product: Product; mayEdit: boolean; onSaved: () => void }) {
  const [monthly, setMonthly] = useState(product.monthlyPrice);
  const [setup, setSetup] = useState(product.setupPrice ?? "");
  const [currency, setCurrency] = useState(product.currency);
  const [tagline, setTagline] = useState(product.tagline);
  const [active, setActive] = useState(product.active);
  const [note, setNote] = useState<string | null>(null);

  // A background refetch must not overwrite what somebody is typing, and it
  // must not leave the boxes showing the old price after a save either.
  useEffect(() => {
    setMonthly(product.monthlyPrice);
    setSetup(product.setupPrice ?? "");
    setCurrency(product.currency);
    setTagline(product.tagline);
    setActive(product.active);
  }, [product.updatedAt]);

  const dirty =
    monthly !== product.monthlyPrice ||
    setup !== (product.setupPrice ?? "") ||
    currency !== product.currency ||
    tagline !== product.tagline ||
    active !== product.active;

  const save = useMutation({
    mutationFn: () =>
      api.patch<{ priceMoved: boolean }>(`/products/${product.key}`, {
        monthlyPrice: monthly.trim(),
        setupPrice: setup.trim() === "" ? null : setup.trim(),
        currency: currency.trim().toUpperCase(),
        tagline: tagline.trim(),
        active,
      }),
    onSuccess: (result) => {
      setNote(result.priceMoved ? "Saved. The website shows the new price on its next load." : "Saved.");
      onSaved();
    },
    onError: (error) => setNote(error instanceof ApiError ? error.message : "That could not be saved."),
  });

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-base tracking-[-.02em]">{product.name}</h2>
          <p className="mt-0.5 font-mono text-[11px] text-muted">
            {product.key} · <a href={`https://dakyworld.com${product.publicPath}`} target="_blank" rel="noreferrer" className="underline-offset-2 hover:text-ink hover:underline">dakyworld.com{product.publicPath}</a>
          </p>
        </div>
        {active ? <Badge tone="positive">On the website</Badge> : <Badge tone="muted">Hidden</Badge>}
      </div>

      <fieldset className="mt-4 grid gap-3 sm:grid-cols-4" disabled={!mayEdit || save.isPending}>
        <label className="text-xs text-muted">
          Currency
          <input className={`${INPUT} mt-1 font-mono uppercase`} maxLength={3} value={currency} onChange={(event) => setCurrency(event.target.value)} />
        </label>
        <label className="text-xs text-muted">
          Each month
          <input className={`${INPUT} mt-1 font-mono`} inputMode="decimal" value={monthly} onChange={(event) => setMonthly(event.target.value)} placeholder="750" />
        </label>
        <label className="text-xs text-muted">
          To set up <span className="text-faint">(blank for none)</span>
          <input className={`${INPUT} mt-1 font-mono`} inputMode="decimal" value={setup} onChange={(event) => setSetup(event.target.value)} placeholder="1500" />
        </label>
        <label className="flex items-end gap-2 pb-2 text-xs text-ink">
          <input type="checkbox" className="h-3.5 w-3.5 accent-blue" checked={active} onChange={(event) => setActive(event.target.checked)} />
          <span>Show on the website</span>
        </label>
        <label className="text-xs text-muted sm:col-span-4">
          One line, under the name on the website
          <input className={`${INPUT} mt-1`} maxLength={300} value={tagline} onChange={(event) => setTagline(event.target.value)} />
        </label>
      </fieldset>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {mayEdit ? (
          <Button size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save price"}
          </Button>
        ) : (
          <span className="text-xs text-muted">Changing a price needs Manage sites access.</span>
        )}
        {note && <span role="status" className="text-xs text-muted">{note}</span>}
        <span className="ml-auto text-[11px] text-muted">
          Last changed <RelativeTime value={product.updatedAt} />
          {product.updatedBy ? ` by ${product.updatedBy.name}` : ""}
        </span>
      </div>
    </section>
  );
}
