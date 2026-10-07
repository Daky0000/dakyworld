import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { useAuth } from "../lib/auth";
import { updateUiState, type HeardFrom, type WebsitePurpose } from "../lib/uiState";
import { notifyTierStatusChanged, useWebsiteTierStatus } from "./WebsiteTierStatusBanner";

/**
 * The first visit, as four short questions and a build you can watch.
 *
 * Every line on the last step is something that has actually happened — the
 * request that creates the site, the page it came back with — not a timer
 * pretending to provision things. The questions only ask what changes what
 * gets built: what the site is for chooses the starter template, how they want
 * to start chooses the route, and the one marketing question is skippable.
 *
 * GitHub is not a way to create the site. A customer's site is created hosted
 * first and their repository is attached from Settings through the DakyXTech
 * GitHub App, because that is the only route the server accepts for them.
 */

type Method = "template" | "upload" | "github" | "team";
type Purpose = WebsitePurpose;

const PURPOSES: { key: Purpose; title: string; sub: string; icon: ReactNode }[] = [
  { key: "business", title: "Business", sub: "Show what we offer", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18" /></svg> },
  { key: "store", title: "Shop", sub: "Show my products", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 7h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9z" /><path d="M9 10V6a3 3 0 0 1 6 0v4" /></svg> },
  { key: "portfolio", title: "Portfolio", sub: "Show my work", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5-9 9" /></svg> },
  { key: "organisation", title: "Other", sub: "Church, NGO, school, event…", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></svg> },
];

/** The follow-up question, and which starter template each answer is built from. */
const FOLLOW: Record<Purpose, { label: string; options: [string, string][] }> = {
  business: { label: "What kind of business?", options: [["Professional services", "business"], ["Food & restaurant", "local"], ["Beauty & salon", "local"], ["Health & clinic", "local"], ["Real estate", "local"], ["Software or online service", "saas"], ["Something else", "business"]] },
  store: { label: "How many products will you show?", options: [["1–10", "local"], ["11–50", "local"], ["More than 50", "local"]] },
  portfolio: { label: "What kind of work?", options: [["Design", "portfolio"], ["Photography", "portfolio"], ["Writing", "portfolio"], ["Development", "portfolio"], ["Something else", "portfolio"]] },
  organisation: { label: "What best describes it?", options: [["Church or ministry", "business"], ["NGO or charity", "business"], ["School", "business"], ["Event", "business"], ["Personal", "blank"], ["Something else", "blank"]] },
};

const HEARD: { key: HeardFrom; label: string }[] = [
  { key: "search", label: "Google / search" },
  { key: "ai", label: "AI assistant" },
  { key: "friend", label: "Friend or colleague" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "tiktok", label: "TikTok" },
  { key: "youtube", label: "YouTube" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "event", label: "An event" },
  { key: "other", label: "Other" },
];

const MAX_UPLOAD = 10_000_000;

type Created = { id: string; pageId: string | null };
type Task = { label: string; state: "waiting" | "working" | "done" | "failed" };

export function WebsiteWelcomeFlow() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { status: tier } = useWebsiteTierStatus();

  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState<Purpose | null>(null);
  const [follow, setFollow] = useState("");
  const [hasSite, setHasSite] = useState<"yes" | "no" | "">("");
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<Method | null>(null);
  const [upload, setUpload] = useState<{ name: string; html?: string; zip?: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [heard, setHeard] = useState<HeardFrom | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [help, setHelp] = useState<{ message: string; paymentUrl: string | null } | null>(null);

  const templateKey = useMemo(() => {
    if (!purpose) return "business";
    return FOLLOW[purpose].options.find(([label]) => label === follow)?.[1] ?? "business";
  }, [purpose, follow]);

  const price = useQuery({
    queryKey: ["website", "setup-assistance-price"],
    enabled: method === "team",
    queryFn: ({ signal }) => api.get<{ display: string }>("/website/setup-assistance", signal),
  });

  const trimmedAddress = address.trim();
  const addressOk = hasSite === "no" || (hasSite === "yes" && /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(trimmedAddress));
  const step0Ok = Boolean(name.trim() && purpose && follow && hasSite && addressOk);
  const step1Ok =
    method === "template" || method === "github" || (method === "upload" && Boolean(upload)) || (method === "team" && phone.replace(/\D/g, "").length >= 9);

  const createSite = useMutation({
    mutationFn: () =>
      api.post<Created>("/website/sites", {
        name: name.trim(),
        ...(hasSite === "yes" && trimmedAddress ? { publicUrl: /^https?:\/\//i.test(trimmedAddress) ? trimmedAddress : `https://${trimmedAddress}` } : {}),
        ...(method === "upload" && upload?.html ? { html: upload.html } : {}),
        ...(method === "upload" && upload?.zip ? { packageData: upload.zip, packageFilename: upload.name } : {}),
        ...(method !== "upload" ? { templateKey } : {}),
      }),
    onSuccess: async (result) => {
      setCreated(result);
      await qc.invalidateQueries({ queryKey: ["website"] });
      notifyTierStatusChanged();
      updateUiState({ welcome: { status: "done", at: new Date().toISOString(), purpose: purpose ?? undefined, heardFrom: heard ?? undefined } });
      if (method === "team") requestHelp.mutate(result.id);
    },
  });

  const requestHelp = useMutation({
    mutationFn: (siteId: string) =>
      api.post<{ message: string; paymentUrl: string | null }>("/website/setup-assistance", {
        siteId,
        route: "hosted",
        websiteUrl: trimmedAddress || undefined,
        notes: [`Phone / WhatsApp: ${phone.trim()}`, notes.trim()].filter(Boolean).join("\n"),
      }),
    onSuccess: (result) => setHelp(result),
  });

  // Starting the build is entering the last step; it runs once.
  useEffect(() => {
    if (step === 3 && !created && !createSite.isPending && !createSite.isError) createSite.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const failure = createSite.error ?? requestHelp.error;
  const failureText = failure ? (failure instanceof ApiError ? failure.message : (failure as Error).message) : null;

  const tasks: Task[] = [
    { label: "Creating your website", state: created ? "done" : createSite.isError ? "failed" : "working" },
    {
      label: method === "upload" ? `Importing ${upload?.name ?? "your file"}` : `Building your first page from the ${templateLabel(templateKey)} starter`,
      state: created ? (created.pageId ? "done" : "failed") : createSite.isError ? "failed" : "waiting",
    },
    ...(method === "team"
      ? [{ label: "Sending your request to our team", state: (help ? "done" : requestHelp.isError ? "failed" : created ? "working" : "waiting") as Task["state"] }]
      : []),
  ];
  const finished = Boolean(created) && (method !== "team" || Boolean(help) || requestHelp.isError);

  const openEditor = () => {
    if (created?.pageId) navigate(`/website/pages/${created.pageId}?walkthrough=interactive`);
    else navigate("/website/sites");
  };

  const readFile = async (file: File) => {
    setUpload(null);
    setUploadError(null);
    if (file.size > MAX_UPLOAD) return setUploadError("That file is over 10 MB. Try the .html page on its own, or a smaller .zip.");
    try {
      if (/\.zip$/i.test(file.name)) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        setUpload({ name: file.name, zip: btoa(binary) });
      } else {
        setUpload({ name: file.name, html: await file.text() });
      }
      if (!name.trim()) setName(file.name.replace(/\.(html?|zip)$/i, "").replace(/[-_]/g, " "));
    } catch {
      setUploadError("That file could not be read.");
    }
  };

  const shownName = name.trim() || "Your website";
  const previewFilled = step === 3 ? Boolean(created) : Boolean(name.trim() || purpose);
  const cams = ["", "ob-cam-1", "ob-cam-2", "ob-cam-3"];

  return (
    <div className="ob">
      <div className="ob-shell">
        <div className="ob-left">
          <div className="ob-bar">
            <button type="button" className="ob-back" aria-label="Back" disabled={step === 0 || step === 3} onClick={() => setStep((value) => value - 1)}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 12H5m6-6-6 6 6 6" /></svg>
            </button>
            <div className="ob-dots" aria-label={`Step ${step + 1} of 4`}>
              {[0, 1, 2, 3].map((index) => <i key={index} className={index <= step ? "on" : ""} />)}
            </div>
            <button type="button" className="ob-skip" style={{ visibility: step === 2 ? "visible" : "hidden" }} onClick={() => { setHeard(null); setStep(3); }}>
              Skip
            </button>
          </div>

          {step === 0 && (
            <section className="ob-view">
              {tier && (
                <span className="ob-plan"><i />Payment confirmed · <b>{tier.tierName} plan</b>{tier.pricing?.priceDisplay ? ` · ${tier.pricing.priceDisplay}/mo` : ""}</span>
              )}
              <h2>Set up your website{user?.name ? `, ${user.name.split(" ")[0]}` : ""}</h2>
              <div className="ob-fld">
                <label htmlFor="ob-name">Website name</label>
                <input id="ob-name" className="ob-inp" placeholder="Accra Bakery" autoComplete="off" value={name} onChange={(event) => setName(event.target.value)} />
              </div>
              <div className="ob-fld">
                <div className="ob-q">What is this website for?<small>It decides which starter page we build for you.</small></div>
                <div className="ob-cards" role="radiogroup" aria-label="What is this website for?">
                  {PURPOSES.map((option) => (
                    <button key={option.key} type="button" role="radio" aria-checked={purpose === option.key} className={`ob-card${purpose === option.key ? " on" : ""}`} onClick={() => { setPurpose(option.key); setFollow(""); }}>
                      <div className="ob-ic">{option.icon}</div>
                      <b>{option.title}</b>
                      <span>{option.sub}</span>
                    </button>
                  ))}
                </div>
              </div>
              {purpose && (
                <div className="ob-fld">
                  <label htmlFor="ob-follow">{FOLLOW[purpose].label}</label>
                  <select id="ob-follow" className="ob-inp ob-sel" value={follow} onChange={(event) => setFollow(event.target.value)}>
                    <option value="" disabled>Select</option>
                    {FOLLOW[purpose].options.map(([label]) => <option key={label}>{label}</option>)}
                  </select>
                </div>
              )}
              {purpose && follow && (
                <div className="ob-fld">
                  <div className="ob-q">Does it already have a web address?</div>
                  <div className="ob-chips">
                    <button type="button" className={`ob-chip${hasSite === "yes" ? " on" : ""}`} onClick={() => setHasSite("yes")}>Yes, I have one</button>
                    <button type="button" className={`ob-chip${hasSite === "no" ? " on" : ""}`} onClick={() => setHasSite("no")}>Not yet</button>
                  </div>
                  {hasSite === "yes" && (
                    <input className="ob-inp" style={{ marginTop: 8 }} aria-label="Web address" placeholder="accrabakery.com" value={address} onChange={(event) => setAddress(event.target.value)} />
                  )}
                  {hasSite === "no" && <p className="ob-hint">That's fine. You can connect your own domain from Settings whenever you're ready.</p>}
                </div>
              )}
              <div className="ob-foot"><button type="button" className="ob-cta" disabled={!step0Ok} onClick={() => setStep(1)}>Continue</button></div>
            </section>
          )}

          {step === 1 && (
            <section className="ob-view">
              <h2>How would you like to start?</h2>
              <p className="ob-lead">You can change any of it later in the editor.</p>
              <div className="ob-fld">
                <div className="ob-cards list" role="radiogroup" aria-label="How would you like to start?">
                  {([
                    ["template", "Start from a ready-made page", `A ${templateLabel(templateKey)} page with “${shownName}” on it, ready to change`, "Recommended"],
                    ["upload", "Upload the page you already have", "An .html file, or a .zip with its pictures", ""],
                    ["github", "Connect a GitHub repository", "For a site whose code lives on GitHub", ""],
                    ["team", "Have our team set it up", "Leave your number and we do the rest", ""],
                  ] as const).map(([key, title, sub, tag]) => (
                    <button key={key} type="button" role="radio" aria-checked={method === key} className={`ob-card${method === key ? " on" : ""}`} onClick={() => setMethod(key)}>
                      <div className="ob-ic">{METHOD_ICON[key]}</div>
                      <b>{title}{tag && <span className="ob-tag">{tag}</span>}</b>
                      <span>{sub}</span>
                    </button>
                  ))}
                </div>
              </div>
              {method === "upload" && (
                <div className="ob-fld">
                  <label className={`ob-drop${upload ? " ok" : ""}`}>
                    <input type="file" accept=".html,.htm,.zip,text/html,application/zip" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} />
                    {upload ? <><b>{upload.name}</b><br />Ready to import</> : <><b>Choose your .html or .zip</b><br />Pictures inside it go into your media library</>}
                  </label>
                  {uploadError && <p className="ob-err">{uploadError}</p>}
                </div>
              )}
              {method === "github" && (
                <p className="ob-note">
                  We create your website now, then you install the DakyX app on GitHub and choose the repository — only that one. Your edits are then committed to it. It takes about two minutes, from Settings.
                </p>
              )}
              {method === "team" && (
                <div className="ob-fld">
                  <label htmlFor="ob-phone">Phone or WhatsApp</label>
                  <input id="ob-phone" className="ob-inp" type="tel" autoComplete="tel" placeholder="+233 20 000 0000" value={phone} onChange={(event) => setPhone(event.target.value)} />
                  <label htmlFor="ob-notes" style={{ marginTop: 12 }}>Anything we should know? <span className="ob-opt">(optional)</span></label>
                  <textarea id="ob-notes" className="ob-inp ob-ta" rows={2} placeholder="My domain is with GoDaddy…" value={notes} onChange={(event) => setNotes(event.target.value)} />
                  <p className="ob-hint">
                    We reply to {user?.email ?? "your email"} within one working day. Setup is a one-off {price.data?.display ?? "fee"}, paid when you confirm — you can explore a starter page while you wait.
                  </p>
                </div>
              )}
              <div className="ob-foot"><button type="button" className="ob-cta" disabled={!step1Ok} onClick={() => setStep(2)}>Continue</button></div>
            </section>
          )}

          {step === 2 && (
            <section className="ob-view">
              <h2>How did you hear about us?</h2>
              <p className="ob-lead">One answer. It helps us know where to spend our time.</p>
              <div className="ob-fld">
                <div className="ob-chips">
                  {HEARD.map((option) => (
                    <button key={option.key} type="button" aria-pressed={heard === option.key} className={`ob-chip${heard === option.key ? " on" : ""}`} onClick={() => setHeard(option.key)}>
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="ob-foot"><button type="button" className="ob-cta" disabled={!heard} onClick={() => setStep(3)}>Build my website</button></div>
            </section>
          )}

          {step === 3 && (
            <section className="ob-view">
              <div className="ob-scroll">
                <div className="ob-you">
                  {shownName} — {PURPOSES.find((option) => option.key === purpose)?.title.toLowerCase()} ({follow.toLowerCase()}),{" "}
                  {method === "upload" ? `from ${upload?.name}` : method === "github" ? "to connect to GitHub" : method === "team" ? "set up with the DakyX team" : "from a ready-made page"}.
                </div>
                <div className="ob-work" aria-live="polite">
                  <div className={`ob-h${finished ? " done" : ""}`}><i /><span>{finished ? `Finished ${tasks.filter((task) => task.state === "done").length} of ${tasks.length}` : "Working…"}</span></div>
                  {tasks.map((task) => (
                    <div key={task.label} className={`ob-task ${task.state}`}>
                      {task.state === "failed"
                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M9 9l6 6M15 9l-6 6" /></svg>
                        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></svg>}
                      <span>{task.label}</span>
                    </div>
                  ))}
                </div>
                {failureText && (
                  <div className="ob-msg">
                    <p className="ob-err" role="alert">{failureText}</p>
                    {createSite.isError && (
                      <button type="button" className="ob-ghost" onClick={() => { createSite.reset(); setStep(1); }}>Go back and change it</button>
                    )}
                  </div>
                )}
                {finished && created && (
                  <div className="ob-msg">
                    {method === "github" ? (
                      <p>Your website is ready. Next, connect the repository it publishes to — open <b>Settings</b>, install the DakyX app on GitHub and choose the repository.</p>
                    ) : method === "team" && help ? (
                      <p>{help.message} Meanwhile there's a starter page to explore — nothing is public until you publish.</p>
                    ) : (
                      <>
                        <p>Your website is ready. Here's what you have:</p>
                        <ul>
                          <li>{method === "upload" ? "Your page, with its pictures in your media library" : "A first page with your name and placeholder words"}</li>
                          <li>A private draft — nothing is public until you publish</li>
                          {tier && <li>{tier.storage.quotaFormatted} of storage for your pictures</li>}
                        </ul>
                        <p>Click any words or picture in the editor to change them. A two-minute tour starts when you open it.</p>
                      </>
                    )}
                  </div>
                )}
              </div>
              {finished && created && (
                <div className="ob-explore">
                  <b>{method === "github" ? "Connect your repository" : "Your website is ready"}</b>
                  <div className="ob-row">
                    {method === "github" && <button type="button" className="ob-ghost" onClick={openEditor}>Look at the page first</button>}
                    {method === "team" && help?.paymentUrl && <a className="ob-ghost" href={help.paymentUrl} target="_blank" rel="noreferrer">Pay {price.data?.display ?? "now"}</a>}
                    <button type="button" className="ob-small-cta" onClick={method === "github" ? () => navigate("/website/settings") : openEditor}>
                      {method === "github" ? "Open Settings" : "Open the editor"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>

        {/* A picture of the editor that fills in as the answers do. Decorative. */}
        <div className="ob-right" aria-hidden="true">
          <div className={`ob-stage ${cams[step]}`}>
            <div className="ob-app">
              <div className="ob-pside">
                <div className="ob-plogo">Daky<b>X</b></div>
                <div className="ob-ws"><span className="ob-av">{shownName[0]?.toUpperCase()}</span><div><b>{shownName}</b><span>{purpose ? PURPOSES.find((option) => option.key === purpose)?.title : tier?.tierName ?? "Website"}</span></div></div>
                <div className="ob-navg">{[0, 1, 2, 3, 4, 5].map((index) => <div key={index} className={`ob-ni${index === 0 ? " hl" : ""}`}><i /><div className="ob-sk" /></div>)}</div>
              </div>
              <div className="ob-pmain">
                <div className="ob-ptop"><div className="ob-sk" style={{ width: 70 }} /><div className="ob-pill" /><div className="ob-pill" /><div className="ob-pub" /></div>
                <div className="ob-canvas">
                  <div className="ob-page">
                    <div className={`ob-site${previewFilled ? "" : " empty"}`}>
                      <div className="ob-ghost-t">Your website will appear here</div>
                      <div className="ob-snav"><span>{shownName}</span><div style={{ display: "flex", gap: 5 }}><div className="ob-sk" style={{ width: 18 }} /><div className="ob-sk" style={{ width: 18 }} /><div className="ob-sk" style={{ width: 18 }} /></div></div>
                      <div className="ob-hero"><div className="ob-sk" style={{ width: "70%", height: 9 }} /><div className="ob-sk" style={{ width: "55%" }} /><div className="ob-sk" style={{ width: "40%" }} /><div className="ob-btnsk" /></div>
                      <div className="ob-cols"><div /><div /><div /></div>
                      <div className="ob-sk" style={{ width: "80%" }} /><div className="ob-sk" style={{ width: "60%" }} />
                    </div>
                  </div>
                  <div className="ob-props"><div className="ob-sk" style={{ width: "70%" }} /><div className="ob-box" /><div className="ob-sk" style={{ width: "50%" }} /><div className="ob-box" /><div className="ob-box" /></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <p className="ob-out">
        Want to read first? The <a href="https://dakyx.com/website-builder-setup" target="_blank" rel="noreferrer">setup guide</a> covers every route.{" "}
        {step < 3 && (
          <button
            type="button"
            onClick={() => {
              updateUiState({ welcome: { status: "skipped", at: new Date().toISOString() } });
              navigate("/website/sites");
            }}
          >
            Skip for now
          </button>
        )}
      </p>
    </div>
  );
}

function templateLabel(key: string) {
  return { business: "business", local: "local business", saas: "online service", portfolio: "portfolio", blank: "simple" }[key] ?? "business";
}

const METHOD_ICON: Record<Method, ReactNode> = {
  template: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M8 13h8M8 16h5" /></svg>,
  upload: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 15V3M7 8l5-5 5 5M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></svg>,
  github: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="6" cy="6" r="2.2" /><circle cx="6" cy="18" r="2.2" /><circle cx="18" cy="9" r="2.2" /><path d="M6 8.2v7.6M18 11.2c0 3-3 4-9.8 5" /></svg>,
  team: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="2.5" y="14" width="4.5" height="6" rx="1.5" /><rect x="17" y="14" width="4.5" height="6" rx="1.5" /></svg>,
};
