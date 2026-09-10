import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { Badge, Button } from "./ui";

/**
 * Connecting a client's repository without asking them for a secret.
 *
 * The old question — "create a personal access token and paste it here" — asks a
 * customer for a credential that reaches everything they own, gives them no way
 * to see what it is used for, and no way to take it back except by revoking it
 * and telling us afterwards. It also puts their token in our database.
 *
 * This asks them to install an app on the repositories they choose. GitHub keeps
 * the boundary, the tokens it lends expire in an hour, and they can narrow or
 * remove the installation themselves. All this screen stores is the number
 * GitHub gives back.
 *
 * The shared token is still there for every site that has no installation, and
 * this screen says so rather than implying a site is broken for not using it.
 */

type AppStatus = { configured: boolean; installUrl: string | null; note: string };
type Repository = { id: string; fullName: string; defaultBranch: string; private: boolean };

export function ConnectGithubApp({
  siteId,
  installationId,
  repoFullName,
  accessLostAt,
  disabled,
}: {
  siteId: string;
  installationId: string | null;
  repoFullName: string | null;
  accessLostAt: string | null;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const [entered, setEntered] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  const status = useQuery({ queryKey: ["website", "github-app"], queryFn: () => api.get<AppStatus>("/website/github-app") });

  const repositories = useQuery({
    queryKey: ["website", "github-app", "repositories", entered || installationId],
    enabled: Boolean(entered || installationId),
    queryFn: () => api.get<{ repositories: Repository[] }>(`/website/github-app/installations/${entered || installationId}/repositories`),
  });

  const connect = useMutation({
    mutationFn: (repository: Repository | null) =>
      api.put(`/website/sites/${siteId}/github-app`, repository ? { installationId: entered || installationId, repositoryId: repository.id } : { installationId: null }),
    onSuccess: () => {
      setFailure(null);
      setEntered("");
      void qc.invalidateQueries({ queryKey: ["website"] });
    },
    onError: (error) => setFailure(error instanceof ApiError ? error.message : "That connection could not be made."),
  });

  if (!status.data) return null;

  if (!status.data.configured) {
    return (
      <section className="rounded-2xl border border-line bg-white p-5">
        <h2 className="font-display text-base tracking-[-.02em]">Customer's own GitHub access</h2>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{status.data.note}</p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-base tracking-[-.02em]">Customer's own GitHub access</h2>
        {installationId ? (
          accessLostAt ? <Badge tone="danger">Access withdrawn</Badge> : <Badge tone="positive">Connected</Badge>
        ) : (
          <Badge tone="muted">Using the shared token</Badge>
        )}
      </div>

      {accessLostAt && (
        <p role="alert" className="mt-2 rounded-xl border border-warn-line bg-warn-surface px-3 py-2 text-sm text-warn-text">
          GitHub told us this installation no longer reaches {repoFullName ?? "this repository"}. The customer may have removed it from the
          Dakyworld app. Publishing will not work until they add it back.
        </p>
      )}

      {installationId ? (
        <>
          <p className="mt-2 text-sm text-muted">
            Publishing to {repoFullName} uses an hour-long token borrowed from installation {installationId}. The customer can narrow or
            remove that access themselves at any time.
          </p>
          <Button className="mt-3" size="sm" variant="ghost" disabled={disabled || connect.isPending} onClick={() => connect.mutate(null)}>
            Stop using it
          </Button>
        </>
      ) : (
        <>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{status.data.note}</p>
          <ol className="mt-3 space-y-2 text-sm text-ink">
            <li>
              1.{" "}
              <a href={status.data.installUrl ?? "#"} target="_blank" rel="noreferrer" className="font-semibold text-blue underline-offset-2 hover:underline">
                Send the customer to install the Dakyworld app
              </a>{" "}
              <span className="text-muted">— they choose “Only select repositories”.</span>
            </li>
            <li className="text-muted">
              2. GitHub sends them back to a URL ending <span className="font-mono text-[12px]">installation_id=…</span>. Paste that number
              here.
            </li>
          </ol>

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted">
              Installation ID
              <input
                className="mt-1 w-48 rounded-xl border border-line bg-white px-3 py-2 font-mono text-sm text-ink outline-none focus:border-blue"
                value={entered}
                inputMode="numeric"
                placeholder="18472931"
                disabled={disabled}
                onChange={(event) => setEntered(event.target.value.replace(/\D/g, ""))}
              />
            </label>
          </div>

          {repositories.isError && (
            <p className="mt-2 text-sm text-warn-text">
              {repositories.error instanceof ApiError ? repositories.error.message : "That installation could not be read."}
            </p>
          )}

          {repositories.data && (
            <div className="mt-3">
              <p className="text-xs text-muted">
                That installation reaches {repositories.data.repositories.length} repositor{repositories.data.repositories.length === 1 ? "y" : "ies"}. Pick this
                website's.
              </p>
              <ul className="mt-1.5 space-y-1">
                {repositories.data.repositories.map((repository) => (
                  <li key={repository.id}>
                    <button
                      type="button"
                      disabled={disabled || connect.isPending}
                      onClick={() => connect.mutate(repository)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-line px-3 py-2 text-left text-sm transition hover:border-blue hover:text-blue disabled:opacity-50"
                    >
                      <span className="font-mono text-[13px]">{repository.fullName}</span>
                      <span className="text-xs text-muted">
                        {repository.private ? "private" : "public"} · {repository.defaultBranch}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {failure && <p role="alert" className="mt-2 text-sm text-danger-text">{failure}</p>}
    </section>
  );
}
