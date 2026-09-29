import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

type Work = { jobId: string; siteId: string; state: string };
export function QueuedWork() {
  const { user } = useAuth();
  const [jobs, setJobs] = useState<Work[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setJobs([]); setError(null); }, [user?.id]);
  useEffect(() => {
    const clear = () => { setJobs([]); setError(null); };
    window.addEventListener("dw:account-changed", clear);
    return () => window.removeEventListener("dw:account-changed", clear);
  }, []);
  useEffect(() => {
    const receive = (event: Event) => {
      const job = (event as CustomEvent<Work>).detail;
      setJobs(current => [ ...current.filter(row => row.jobId !== job.jobId), ...(["QUEUED", "RUNNING"].includes(job.state) ? [job] : []) ]);
    };
    window.addEventListener("dw:queued-work", receive);
    return () => window.removeEventListener("dw:queued-work", receive);
  }, []);
  if (!jobs.length) return null;
  return <aside aria-label="Background work" className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border bg-white p-4 shadow-lg">
    {jobs.map(job => <div key={job.jobId} className="flex items-center gap-3 py-1">
      <span role="status">{job.state === "RUNNING" ? "Preparing your changes…" : "Your request is queued."}</span>
      <button className="underline" onClick={() => void api.post(`/website/sites/${job.siteId}/work-jobs/${job.jobId}/cancel`).catch(err => setError(err.message))}>Cancel</button>
    </div>)}
    {error && <p role="alert">{error}</p>}
  </aside>;
}
