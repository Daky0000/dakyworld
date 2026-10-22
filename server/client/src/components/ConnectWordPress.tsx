import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button } from "./ui";

/**
 * Connecting a WordPress website with an Application Password.
 *
 * The steps come first and stay on screen, because the step where people stop
 * is not typing a password, it is finding where WordPress makes one. "Check
 * connection" tries the three things together and says what it found — or, when
 * WordPress refuses, which of the half-dozen reasons it was, each with its own
 * fix — before anything is saved. "Connect" checks again on the server, so a
 * password that does not work is never stored.
 */

type WordPressDetails = {
  siteName: string;
  siteUrl: string;
  version: string | null;
  user: { id: number; name: string; roles: string[] };
  canEditPages: boolean;
  canUploadFiles: boolean;
  pageCount: number | null;
  builders: string[];
  warnings: string[];
};

export const WORDPRESS_GUIDE = "https://dakyx.com/website-builder-setup#wordpress";

/** Where an Application Password is made, on the site they typed. */
function profileUrl(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}/wp-admin/profile.php#application-passwords-section`;
  } catch {
    return null;
  }
}

export function ConnectWordPress({ guide, onConnected }: { guide?: string; onConnected: () => void }) {
  const [address, setAddress] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [checked, setChecked] = useState<WordPressDetails | null>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const credentials = () => ({ address: address.trim(), username: username.trim(), password });
  const ready = Boolean(address.trim() && username.trim() && password.trim());

  const check = useMutation({
    mutationFn: () => api.post<WordPressDetails>("/website/wordpress/check", credentials()),
    onSuccess: (details) => {
      setChecked(details);
      if (!name.trim()) setName(details.siteName);
    },
    onError: () => setChecked(null),
  });

  const connect = useMutation({
    mutationFn: () =>
      api.post<{ id: string; pageId: string | null; wordpress?: { pagesError: string | null } }>("/website/sites", {
        name: name.trim() || checked?.siteName || address.trim(),
        wordpress: credentials(),
      }),
    onSuccess: async (result) => {
      await qc.invalidateQueries({ queryKey: ["website"] });
      onConnected();
      navigate(result.pageId ? `/website/pages/${result.pageId}` : "/website/sites");
    },
  });

  // Anything typed after a check makes that check stale.
  const edit = (set: (value: string) => void) => (event: React.ChangeEvent<HTMLInputElement>) => {
    set(event.target.value);
    setChecked(null);
    check.reset();
    connect.reset();
  };
  const profile = profileUrl(address);
  const input = "mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink";

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (checked) connect.mutate();
        else check.mutate();
      }}
    >
      <p className="text-sm leading-relaxed text-muted">
        Nothing is installed on your website. You make a separate password for DakyXTech in WordPress, and publishing
        writes your changes into the same pages there. You can switch it off at any time.
      </p>

      <ol className="space-y-2 rounded-xl bg-sunken p-4 text-xs leading-relaxed text-ink">
        <li>
          <strong>1. Sign in to WordPress</strong> with an Administrator or Editor account, and open{" "}
          <strong>Users → Profile</strong>
          {profile && (
            <>
              {" "}
              (
              <a className="text-blue underline" href={profile} target="_blank" rel="noreferrer">
                open it on your site
              </a>
              )
            </>
          )}
          .
        </li>
        <li>
          <strong>2. Scroll down to Application Passwords.</strong> Type <code>DakyXTech</code> as the name and press{" "}
          <strong>Add New Application Password</strong>.
        </li>
        <li>
          <strong>3. Copy the password WordPress shows</strong> — 24 letters and numbers in groups of four. It is shown
          once. The spaces do not matter.
        </li>
        <li>
          <strong>4. Paste it below</strong> with your WordPress username, then press <strong>Check connection</strong>.
        </li>
      </ol>

      <details className="text-xs leading-relaxed text-muted">
        <summary className="cursor-pointer font-semibold text-ink">No “Application Passwords” section on your profile?</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>The website must be on <strong>https://</strong>. Most hosts switch it on for free from their control panel.</li>
          <li>WordPress must be 5.6 or newer. Update it from Dashboard → Updates.</li>
          <li>
            A security plugin may have switched them off — in Wordfence it is Login Security → Settings → “Disable
            WordPress application passwords”; Solid Security and All-In-One Security have similar switches.
          </li>
        </ul>
        <p className="mt-2">
          Every step, and what to do when one does not work, is in{" "}
          <a className="text-blue underline" href={guide ?? WORDPRESS_GUIDE} target="_blank" rel="noreferrer">
            the WordPress guide
          </a>
          .
        </p>
      </details>

      <label className="block text-xs text-muted">
        Website address
        <input autoFocus required value={address} onChange={edit(setAddress)} placeholder="yourbusiness.com" className={input} />
      </label>
      <label className="block text-xs text-muted">
        WordPress username
        <input required value={username} onChange={edit(setUsername)} autoComplete="off" placeholder="The name you sign in to WordPress with" className={input} />
      </label>
      <label className="block text-xs text-muted">
        Application Password
        <input
          required
          type="password"
          value={password}
          onChange={edit(setPassword)}
          autoComplete="new-password"
          placeholder="abcd EFGH 1234 ijkl MNOP 5678"
          className={`${input} font-mono`}
        />
        <span className="mt-1 block text-[11px] text-muted">
          Not your WordPress login password — the one you made in step 2. It is stored encrypted and never shown again.
        </span>
      </label>

      {checked && (
        <div role="status" className="space-y-2 rounded-xl border border-positive-line bg-positive-surface p-4 text-sm text-positive-text">
          <p className="font-semibold">
            Connected to {checked.siteName} as {checked.user.name}.
          </p>
          <p className="text-xs">
            {[
              checked.version ? `WordPress ${checked.version}` : null,
              checked.pageCount !== null ? `${checked.pageCount} published page${checked.pageCount === 1 ? "" : "s"}` : null,
              checked.builders.length ? `Builders: ${checked.builders.join(", ")}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {checked.warnings.map((warning) => (
            <p key={warning} className="rounded-lg border border-warn-line bg-warn-surface p-2 text-xs text-warn-text">
              {warning}
            </p>
          ))}
          <label className="block text-xs text-ink">
            Name it in the Builder
            <input value={name} onChange={(event) => setName(event.target.value)} className={`${input} bg-white`} />
          </label>
        </div>
      )}

      {(check.error || connect.error) && (
        <p role="alert" className="rounded-xl border border-danger-line bg-danger-surface p-3 text-sm text-danger-text">
          {((check.error || connect.error) as Error).message}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {checked ? (
          <>
            <Button variant="ghost" type="button" disabled={check.isPending || connect.isPending} onClick={() => check.mutate()}>
              Check again
            </Button>
            <Button type="submit" disabled={connect.isPending}>
              {connect.isPending ? "Connecting… reading your pages" : "Connect and open"}
            </Button>
          </>
        ) : (
          <Button type="submit" disabled={!ready || check.isPending}>
            {check.isPending ? "Checking…" : "Check connection"}
          </Button>
        )}
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Elementor pages (classic and V4) can be edited in full — words, links, pictures, styling, hover and layout,
        headers and footers included with an Administrator account. On pages made with the block editor, the classic
        editor, Divi, WPBakery or Avada you edit words, links and pictures. Pages built with Beaver Builder, Bricks or
        Oxygen open read-only for now.
      </p>
    </form>
  );
}

type ConnectionView = {
  connected: boolean;
  connection: {
    siteUrl: string;
    username: string;
    details: WordPressDetails | null;
    verifiedAt: string | null;
    pausedAt: string | null;
    pausedReason: string | null;
  } | null;
};

/**
 * A WordPress site's connection, on Website settings: who publishing signs in
 * as, whether WordPress still accepts it, and a place to paste a new password
 * when somebody has revoked the old one. Paused means WordPress stopped taking
 * the password; the reason is WordPress's own, translated.
 */
export function WebsiteWordPressPanel({ siteId }: { siteId: string }) {
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ["website", "wordpress", siteId], queryFn: ({ signal }) => api.get<ConnectionView>(`/website/sites/${siteId}/wordpress`, signal) });
  const [open, setOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const replace = useMutation({
    mutationFn: () => api.put<ConnectionView>(`/website/sites/${siteId}/wordpress`, { address: view.data?.connection?.siteUrl ?? "", username: username.trim(), password }),
    onSuccess: async (result) => {
      qc.setQueryData(["website", "wordpress", siteId], result);
      setOpen(false);
      setPassword("");
    },
  });
  const connection = view.data?.connection;
  if (view.isLoading) return <p className="text-sm text-muted">Loading the WordPress connection…</p>;
  if (view.error) return <p role="alert" className="text-sm text-danger-text">{(view.error as Error).message}</p>;
  if (!connection) return null;
  const input = "mt-1 h-10 w-full rounded-xl border border-line px-3 text-sm text-ink";
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <h2 className="mb-1 font-display text-lg">WordPress</h2>
      <p className="text-sm text-muted">
        Publishing writes into{" "}
        <a className="text-blue underline" href={connection.siteUrl} target="_blank" rel="noreferrer">
          {connection.siteUrl.replace(/^https?:\/\//, "")}
        </a>{" "}
        as <strong className="text-ink">{connection.username}</strong>, with an Application Password.
        {connection.details?.version ? ` WordPress ${connection.details.version}.` : ""}
      </p>
      {connection.pausedAt ? (
        <p role="alert" className="mt-3 rounded-xl border border-danger-line bg-danger-surface p-3 text-sm text-danger-text">
          WordPress stopped accepting the password, so nothing can be published until it is replaced. {connection.pausedReason}
        </p>
      ) : (
        <p className="mt-3 text-xs text-muted">
          To take access away, revoke <strong>DakyXTech</strong> under Users → Profile → Application Passwords in WordPress.
        </p>
      )}
      {connection.details?.warnings?.map((warning) => (
        <p key={warning} className="mt-3 rounded-xl border border-warn-line bg-warn-surface p-3 text-xs text-warn-text">
          {warning}
        </p>
      ))}
      {open ? (
        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            replace.mutate();
          }}
        >
          <label className="block text-xs text-muted">
            WordPress username
            <input required autoComplete="off" value={username} onChange={(event) => setUsername(event.target.value)} className={input} />
          </label>
          <label className="block text-xs text-muted">
            New Application Password
            <input required type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className={`${input} font-mono`} />
          </label>
          {replace.error && <p role="alert" className="text-sm text-danger-text">{(replace.error as Error).message}</p>}
          <div className="flex gap-2">
            <Button type="submit" disabled={replace.isPending}>{replace.isPending ? "Checking…" : "Check and save"}</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="mt-4"
          onClick={() => {
            setUsername(connection.username);
            setOpen(true);
            replace.reset();
          }}
        >
          Replace the password
        </Button>
      )}
    </section>
  );
}
