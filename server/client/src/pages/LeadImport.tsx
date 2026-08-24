import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../lib/api";
import type {
  AnalyzeResponse,
  DriveFile,
  AppSettings,
  ImportPlan,
  LeadImportRecord,
  PlanColumn,
  PlanTable,
  TablePreview,
} from "../lib/types";
import type { LeadFieldType } from "../lib/types";
import { FIELD_TYPES, useLeadFields } from "../components/LeadColumns";
import { Badge, Button, Card, EmptyState, Field, PageHeader, RelativeTime, StatusDot, StatTile } from "../components/ui";

const LEAD_SOURCES = [
  "REFERRAL",
  "LINKEDIN",
  "COLD_EMAIL",
  "OUTREACH",
  "CONTENT",
  "WARM_NETWORK",
  "GOOGLE_MAPS",
  "WEB_SCRAPE",
  "DIRECTORY",
  "SOCIAL",
  "OTHER",
];

/** Browsers hand over an ArrayBuffer; the API takes base64 in a JSON body. */
async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunk = 0x8000; // String.fromCharCode dies on very large spreads
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

interface Upload {
  name: string;
  size: number;
  dataBase64: string;
}

/**
 * Importing a lead sheet.
 *
 * The hard part of a lead sheet is never the parsing — it's that the file holds
 * several tables with different columns, a heading row nobody marked as one,
 * and columns the CRM has never heard of. So the file is read, described by the
 * analyst, and shown back as a plan the Owner corrects before anything is
 * written: every table becomes its own batch with its own columns.
 */
export function LeadImport() {
  const qc = useQueryClient();
  const [upload, setUpload] = useState<Upload | null>(null);
  const [driveFile, setDriveFile] = useState<DriveFile | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [chosenSheets, setChosenSheets] = useState<string[]>([]);
  const [useAi, setUseAi] = useState(true);
  const [analysis, setAnalysis] = useState<AnalyzeResponse | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [previews, setPreviews] = useState<TablePreview[]>([]);
  const [done, setDone] = useState<{ groups: { id: string; name: string; leads: number }[]; created: number; updated: number } | null>(
    null,
  );

  const { data: connections } = useQuery({
    queryKey: ["settings"],
    queryFn: () => api.get<AppSettings>("/settings"),
  });
  const { data: history } = useQuery({
    queryKey: ["imports"],
    queryFn: () => api.get<LeadImportRecord[]>("/imports"),
  });

  const analyze = useMutation({
    mutationFn: () =>
      api.post<AnalyzeResponse>("/imports/analyze", {
        source: driveFile ? "GOOGLE_SHEET" : "UPLOAD",
        fileName: upload?.name,
        dataBase64: upload?.dataBase64,
        driveFileId: driveFile?.id,
        sheetNames: chosenSheets.length ? chosenSheets : undefined,
        useAi,
      }),
    onSuccess: (result) => {
      setAnalysis(result);
      setPlan(result.plan);
      setPreviews(result.previews);
      setDone(null);
      void qc.invalidateQueries({ queryKey: ["imports"] });
    },
  });

  const recheck = useMutation({
    mutationFn: () =>
      api.post<{ plan: ImportPlan; previews: TablePreview[] }>(`/imports/${analysis?.import.id}/preview`, {
        plan,
        dataBase64: upload?.dataBase64,
        fileName: upload?.name,
      }),
    onSuccess: (result) => {
      setPlan(result.plan);
      setPreviews(result.previews);
    },
  });

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ result: { groups: { id: string; name: string; leads: number }[]; leadsCreated: number; leadsUpdated: number } }>(
        `/imports/${analysis?.import.id}/commit`,
        { plan, dataBase64: upload?.dataBase64, fileName: upload?.name },
      ),
    onSuccess: (response) => {
      setDone({ groups: response.result.groups, created: response.result.leadsCreated, updated: response.result.leadsUpdated });
      void qc.invalidateQueries({ queryKey: ["imports"] });
      void qc.invalidateQueries({ queryKey: ["leads"] });
      void qc.invalidateQueries({ queryKey: ["lead-stats"] });
      void qc.invalidateQueries({ queryKey: ["lead-fields"] });
    },
  });

  const reset = () => {
    setUpload(null);
    setDriveFile(null);
    setSheets([]);
    setChosenSheets([]);
    setAnalysis(null);
    setPlan(null);
    setPreviews([]);
    setDone(null);
    analyze.reset();
    commit.reset();
  };

  const includedTables = plan?.tables.filter((table) => table.include !== false) ?? [];
  const totalRows = previews
    .filter((preview) => includedTables.some((table) => table.id === preview.tableId))
    .reduce((sum, preview) => sum + preview.rowCount, 0);

  return (
    <div>
      <PageHeader
        title="Import a lead sheet"
        subtitle="Point at a spreadsheet — messy is fine. Every table it holds becomes its own batch, with its own columns."
        action={
          <div className="flex items-center gap-3">
            {analysis && (
              <Button variant="ghost" size="sm" onClick={reset}>
                Start over
              </Button>
            )}
            <Link
              to="/leads"
              className="inline-flex items-center gap-2 border border-ink/20 px-4 py-2 font-mono text-xs uppercase tracking-[.12em] transition hover:border-ink"
            >
              Back to leads
            </Link>
          </div>
        }
      />

      <Connections connections={connections} />

      {done ? (
        <Finished done={done} onAgain={reset} />
      ) : (
        <>
          <SourceStep
            connections={connections}
            upload={upload}
            driveFile={driveFile}
            sheets={sheets}
            chosenSheets={chosenSheets}
            useAi={useAi}
            busy={analyze.isPending}
            error={analyze.error}
            onUpload={(next, tabs) => {
              setUpload(next);
              setDriveFile(null);
              setSheets(tabs);
              setChosenSheets(tabs);
              setAnalysis(null);
              setDone(null);
            }}
            onDrive={(file, tabs) => {
              setDriveFile(file);
              setUpload(null);
              setSheets(tabs);
              setChosenSheets(tabs);
              setAnalysis(null);
              setDone(null);
            }}
            onSheets={setChosenSheets}
            onUseAi={setUseAi}
            onAnalyze={() => analyze.mutate()}
          />

          {analysis && plan && (
            <ReviewStep
              analysis={analysis}
              plan={plan}
              previews={previews}
              onPlan={setPlan}
              onRecheck={() => recheck.mutate()}
              onCommit={() => commit.mutate()}
              rechecking={recheck.isPending}
              committing={commit.isPending}
              error={commit.error ?? recheck.error}
              totalRows={totalRows}
            />
          )}
        </>
      )}

      <History history={history ?? []} />
    </div>
  );
}

// --- Connections -----------------------------------------------------------

/**
 * A read-out with a way through to Settings, where the keys actually live.
 * Both integrations are optional here — an upload mapped by pattern rules is a
 * complete import — so this says what's on rather than blocking the page.
 */
function Connections({ connections }: { connections?: AppSettings }) {
  const analyst = connections?.analyst;
  const google = connections?.google;

  return (
    <Card className="mb-8">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <span className="font-mono text-[11px] uppercase tracking-[.14em] text-ink/60">Connections</span>

        <span className="flex items-center gap-2 text-sm">
          <StatusDot tone={analyst?.reading.ready ? "ok" : "idle"} />
          {analyst?.reading.ready ? (
            <span className="text-ink/70">AI analyst on</span>
          ) : (
            <span className="text-ink/50">No AI analyst — sheets are mapped by pattern rules</span>
          )}
        </span>

        <span className="flex items-center gap-2 text-sm">
          <StatusDot tone={google?.connected ? "ok" : google?.configured ? "warn" : "idle"} />
          {google?.connected ? (
            <span className="text-ink/70">Drive: {google.account ?? "connected"}</span>
          ) : (
            <span className="text-ink/50">Drive not connected — upload a file instead</span>
          )}
        </span>

        <span className="flex-1" />
        <Link
          to="/settings"
          className="font-mono text-[10px] uppercase tracking-[.14em] text-blue transition hover:underline"
        >
          Set up in Settings →
        </Link>
      </div>
    </Card>
  );
}

// --- Step one: the file ----------------------------------------------------

function SourceStep({
  connections,
  upload,
  driveFile,
  sheets,
  chosenSheets,
  useAi,
  busy,
  error,
  onUpload,
  onDrive,
  onSheets,
  onUseAi,
  onAnalyze,
}: {
  connections?: AppSettings;
  upload: Upload | null;
  driveFile: DriveFile | null;
  sheets: string[];
  chosenSheets: string[];
  useAi: boolean;
  busy: boolean;
  error: unknown;
  onUpload: (upload: Upload, sheets: string[]) => void;
  onDrive: (file: DriveFile, sheets: string[]) => void;
  onSheets: (sheets: string[]) => void;
  onUseAi: (value: boolean) => void;
  onAnalyze: () => void;
}) {
  const [tab, setTab] = useState<"upload" | "drive">("upload");
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const readFile = async (file: File) => {
    setReading(true);
    setReadError(null);
    try {
      const dataBase64 = await toBase64(file);
      const { sheets: tabs } = await api.post<{ sheets: string[] }>("/imports/sheets", { fileName: file.name, dataBase64 });
      onUpload({ name: file.name, size: file.size, dataBase64 }, tabs);
    } catch (err) {
      setReadError(err instanceof Error ? err.message : "Could not read that file");
    } finally {
      setReading(false);
    }
  };

  const chosen = upload || driveFile;

  return (
    <Card className="mb-8">
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <TabButton active={tab === "upload"} onClick={() => setTab("upload")}>
          Upload a file
        </TabButton>
        <TabButton active={tab === "drive"} onClick={() => setTab("drive")}>
          From Google Drive
        </TabButton>
      </div>

      {tab === "upload" ? (
        <div
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files?.[0];
            if (file) void readFile(file);
          }}
          className="border border-dashed border-ink/20 p-8 text-center"
        >
          <input
            ref={fileInput}
            type="file"
            accept=".xlsx,.xlsm,.csv,.tsv,.txt"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void readFile(file);
            }}
          />
          <p className="text-sm text-ink/60">Drop an .xlsx or .csv here, or</p>
          <div className="mt-3">
            <Button variant="secondary" onClick={() => fileInput.current?.click()} disabled={reading}>
              {reading ? "Reading…" : "Choose a file"}
            </Button>
          </div>
          {upload && (
            <p className="mt-4 text-sm">
              <strong>{upload.name}</strong>{" "}
              <span className="text-ink/50">({Math.max(1, Math.round(upload.size / 1024))} KB)</span>
            </p>
          )}
          {readError && <Note tone="bad">{readError}</Note>}
        </div>
      ) : (
        <DrivePicker connections={connections} selected={driveFile} onPick={onDrive} />
      )}

      {chosen && sheets.length > 1 && (
        <div className="mt-6">
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-[.16em] text-ink/40">Tabs to read</h3>
          <div className="flex flex-wrap gap-2">
            {sheets.map((sheet) => {
              const active = chosenSheets.includes(sheet);
              return (
                <button
                  key={sheet}
                  type="button"
                  onClick={() => onSheets(active ? chosenSheets.filter((name) => name !== sheet) : [...chosenSheets, sheet])}
                  className={`px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.1em] transition ${
                    active ? "bg-ink text-cream" : "bg-ink/5 text-ink/50 hover:text-ink"
                  }`}
                >
                  {sheet}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {chosen && (
        <div className="mt-6 flex flex-wrap items-center gap-4 border-t border-ink/10 pt-5">
          <label className="flex items-center gap-2 text-sm text-ink/70">
            <input type="checkbox" checked={useAi} onChange={(event) => onUseAi(event.target.checked)} className="h-3.5 w-3.5 accent-blue" />
            Let the AI analyst read it
            {!connections?.analyst.reading.ready && <span className="text-xs text-ink/40">(no model connected — pattern rules will be used)</span>}
          </label>
          <span className="flex-1" />
          <Button onClick={onAnalyze} disabled={busy || (chosenSheets.length === 0 && sheets.length > 0)}>
            {busy ? "Reading the sheet…" : "Analyse"}
          </Button>
        </div>
      )}

      {error instanceof Error && <Note tone="bad">{error.message}</Note>}
    </Card>
  );
}

function DrivePicker({
  connections,
  selected,
  onPick,
}: {
  connections?: AppSettings;
  selected: DriveFile | null;
  onPick: (file: DriveFile, sheets: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [term, setTerm] = useState("");
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["drive-files", term],
    queryFn: () => api.get<{ files: DriveFile[] }>(`/imports/google/files${term ? `?q=${encodeURIComponent(term)}` : ""}`),
    enabled: Boolean(connections?.google.connected),
  });

  if (!connections?.google.connected) {
    return (
      <EmptyState message="Google Drive isn't connected yet. Open Connections above to link an account — it's read-only." />
    );
  }

  const pick = async (file: DriveFile) => {
    setLoadingId(file.id);
    try {
      const detail = await api.get<{ file: DriveFile; sheets: string[] }>(`/imports/google/files/${file.id}`);
      onPick(detail.file, detail.sheets);
    } finally {
      setLoadingId(null);
    }
  };

  return (
    <div>
      <form
        className="mb-4 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setTerm(search.trim());
        }}
      >
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search your Drive…"
          className="flex-1 border border-ink/15 px-3 py-1.5 text-sm outline-none transition focus:border-ink/50"
        />
        <Button type="submit" variant="secondary" size="sm">
          Search
        </Button>
      </form>

      {error instanceof Error && <Note tone="bad">{error.message}</Note>}
      {isLoading ? (
        <p className="text-sm text-ink/50">Loading…</p>
      ) : !data?.files.length ? (
        <p className="text-sm text-ink/50">No spreadsheets found.</p>
      ) : (
        <ul className="max-h-72 divide-y divide-ink/5 overflow-y-auto rounded-2xl border border-line">
          {data.files.map((file) => (
            <li key={file.id}>
              <button
                type="button"
                onClick={() => void pick(file)}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition hover:bg-cream ${
                  selected?.id === file.id ? "bg-blue/5" : ""
                }`}
              >
                <span className="flex-1 truncate">{file.name}</span>
                {file.modifiedTime && (
                  <span className="text-xs text-ink/40">
                    <RelativeTime value={file.modifiedTime} />
                  </span>
                )}
                {loadingId === file.id && <span className="font-mono text-[10px] uppercase text-ink/40">opening…</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Step two: the plan ----------------------------------------------------

function ReviewStep({
  analysis,
  plan,
  previews,
  onPlan,
  onRecheck,
  onCommit,
  rechecking,
  committing,
  error,
  totalRows,
}: {
  analysis: AnalyzeResponse;
  plan: ImportPlan;
  previews: TablePreview[];
  onPlan: (plan: ImportPlan) => void;
  onRecheck: () => void;
  onCommit: () => void;
  rechecking: boolean;
  committing: boolean;
  error: unknown;
  totalRows: number;
}) {
  const { data: fieldSet } = useLeadFields(null);
  const included = plan.tables.filter((table) => table.include !== false);

  const updateTable = (index: number, patch: Partial<PlanTable>) => {
    onPlan({ ...plan, tables: plan.tables.map((table, position) => (position === index ? { ...table, ...patch } : table)) });
  };

  return (
    <section className="mb-10">
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Tables found" value={plan.tables.length} sub={`${included.length} ticked for import`} />
        <StatTile label="Leads to create" value={totalRows} sub="Existing ones are refreshed, not duplicated" />
        <StatTile label="Read by" value={analysis.import.analyzedBy === "rules" ? "Pattern rules" : "AI analyst"} sub={analysis.import.analyzedBy ?? ""} />
        <StatTile label="Sheets read" value={analysis.sheets.length} sub={analysis.sheets.map((sheet) => sheet.name).join(", ")} />
      </div>

      {analysis.warning && <Note tone="warn">{analysis.warning}</Note>}
      {plan.summary && <p className="mb-6 border-l-2 border-blue/60 bg-white px-4 py-3 text-sm text-ink/70">{plan.summary}</p>}

      {/*
        Said rather than done quietly. A boundary the analyst got wrong is the
        one thing on this screen worth checking before importing — it is where
        a lead goes missing or gets written into two groups — and a plan
        silently corrected is a plan nobody checks.
      */}
      {analysis.repairs && analysis.repairs.length > 0 && (
        <Note tone="warn">
          <span className="font-medium">Corrected before review.</span> Check these boundaries against your file:
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {analysis.repairs.map((repair) => (
              <li key={repair}>{repair}</li>
            ))}
          </ul>
        </Note>
      )}

      <div className="space-y-6">
        {plan.tables.map((table, index) => (
          <TableCard
            key={table.id}
            table={table}
            preview={previews.find((entry) => entry.tableId === table.id)}
            builtins={fieldSet?.builtins ?? []}
            onChange={(patch) => updateTable(index, patch)}
          />
        ))}
      </div>

      {error instanceof Error && <Note tone="bad">{error.message}</Note>}

      <div className="sticky bottom-4 mt-6 flex flex-wrap items-center gap-3 border border-ink bg-ink px-4 py-3 text-cream">
        <span className="font-mono text-[11px] uppercase tracking-[.14em]">
          {included.length} batch{included.length === 1 ? "" : "es"} · {totalRows} leads
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onRecheck}
          disabled={rechecking}
          className="font-mono text-[10px] uppercase tracking-[.14em] text-cream/70 transition hover:text-cream disabled:opacity-50"
        >
          {rechecking ? "Rechecking…" : "Recheck preview"}
        </button>
        <button
          type="button"
          onClick={onCommit}
          disabled={committing || !included.length}
          className="bg-cream px-4 py-2 font-mono text-[11px] uppercase tracking-[.12em] text-ink transition hover:bg-white disabled:opacity-50"
        >
          {committing ? "Importing…" : "Import into leads"}
        </button>
      </div>
    </section>
  );
}

function TableCard({
  table,
  preview,
  builtins,
  onChange,
}: {
  table: PlanTable;
  preview?: TablePreview;
  builtins: { key: string; label: string; writable: boolean }[];
  onChange: (patch: Partial<PlanTable>) => void;
}) {
  const [showColumns, setShowColumns] = useState(false);

  const updateColumn = (index: number, patch: Partial<PlanColumn>) => {
    onChange({ columns: table.columns.map((column, position) => (position === index ? { ...column, ...patch } : column)) });
  };

  const kept = table.columns.filter((column) => column.field !== "ignore");
  const custom = kept.filter((column) => column.field === "custom");

  return (
    <Card className={table.include === false ? "opacity-50" : ""}>
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <input
          type="checkbox"
          checked={table.include !== false}
          onChange={(event) => onChange({ include: event.target.checked })}
          className="mt-2 h-4 w-4 accent-blue"
          aria-label={`Import ${table.title}`}
        />
        <div className="min-w-[14rem] flex-1">
          <input
            value={table.title}
            onChange={(event) => onChange({ title: event.target.value })}
            className="w-full border-b border-transparent bg-transparent font-display text-xl outline-none transition focus:border-ink/30"
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">
            {table.sheet} · rows {table.firstDataRow + 1}–{table.lastDataRow + 1}
            {table.headerRow !== null && ` · header row ${table.headerRow + 1}`} · {kept.length} columns
            {custom.length > 0 && ` (${custom.length} new)`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={table.confidence >= 0.75 ? "positive" : "muted"}>{Math.round(table.confidence * 100)}% sure</Badge>
          {preview && <Badge tone="muted">{preview.rowCount} rows</Badge>}
          {preview && preview.skipped > 0 && <Badge tone="default">{preview.skipped} skipped</Badge>}
        </div>
      </div>

      {table.notes && <p className="mb-4 text-sm text-ink/60">{table.notes}</p>}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
          Source
          <select
            value={table.leadSource}
            onChange={(event) => onChange({ leadSource: event.target.value })}
            className="border border-ink/15 bg-white px-2 py-1 text-[10px]"
          >
            {LEAD_SOURCES.map((source) => (
              <option key={source} value={source}>
                {source.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
          Rows start at
          <input
            type="number"
            min={1}
            value={table.firstDataRow + 1}
            onChange={(event) => onChange({ firstDataRow: Math.max(0, Number(event.target.value) - 1) })}
            className="w-20 border border-ink/15 px-2 py-1 text-[11px]"
          />
        </label>
        <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
          and end at
          <input
            type="number"
            min={1}
            value={table.lastDataRow + 1}
            onChange={(event) => onChange({ lastDataRow: Math.max(0, Number(event.target.value) - 1) })}
            className="w-20 border border-ink/15 px-2 py-1 text-[11px]"
          />
        </label>
        <span className="flex-1" />
        <Button variant="ghost" size="sm" onClick={() => setShowColumns((value) => !value)}>
          {showColumns ? "Hide column mapping" : "Edit column mapping"}
        </Button>
      </div>

      {showColumns && (
        <div className="mb-5 rounded-2xl border border-line">
          {table.columns.map((column, index) => (
            <div key={`${column.index}-${index}`} className="flex flex-wrap items-center gap-2 border-b border-ink/5 px-3 py-2 last:border-0">
              <span className="w-28 truncate font-mono text-[10px] uppercase tracking-[.1em] text-ink/40" title={column.header}>
                {column.header || `col ${column.index + 1}`}
              </span>
              <input
                value={column.label}
                onChange={(event) => updateColumn(index, { label: event.target.value })}
                className="w-44 border border-ink/15 px-2 py-1 text-sm outline-none transition focus:border-ink/50"
              />
              <select
                value={column.field}
                onChange={(event) => updateColumn(index, { field: event.target.value })}
                className="border border-ink/15 bg-white px-2 py-1 text-xs"
              >
                <option value="custom">New column of its own</option>
                <option value="ignore">Don't import</option>
                {builtins
                  .filter((builtin) => builtin.writable)
                  .map((builtin) => (
                    <option key={builtin.key} value={builtin.key}>
                      {builtin.label}
                    </option>
                  ))}
              </select>
              {column.field === "custom" && (
                <select
                  value={column.type}
                  onChange={(event) => updateColumn(index, { type: event.target.value as LeadFieldType })}
                  className="border border-ink/15 bg-white px-2 py-1 font-mono text-[10px] uppercase tracking-[.08em]"
                >
                  {FIELD_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replace("_", " ")}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
          <p className="border-t border-ink/10 bg-cream px-3 py-2 text-xs text-ink/50">
            Change anything here and hit “Recheck preview” to see the effect before importing.
          </p>
        </div>
      )}

      {preview && preview.sample.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-ink/10 bg-cream font-mono text-[10px] uppercase tracking-[.1em] text-ink/50">
                {Object.keys(preview.sample[0]).map((header) => (
                  <th key={header} className="whitespace-nowrap px-3 py-2">
                    {header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {preview.sample.map((row, index) => (
                <tr key={index} className="border-b border-ink/5 last:border-0">
                  {Object.keys(preview.sample[0]).map((header) => (
                    <td key={header} className="max-w-[16rem] truncate px-3 py-2" title={row[header]}>
                      {row[header] || <span className="text-ink/25">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// --- Aftermath -------------------------------------------------------------

function Finished({
  done,
  onAgain,
}: {
  done: { groups: { id: string; name: string; leads: number }[]; created: number; updated: number };
  onAgain: () => void;
}) {
  return (
    <Card className="mb-8">
      <h2 className="font-display text-2xl">Imported</h2>
      <p className="mt-1 text-sm text-ink/60">
        {done.created} new lead{done.created === 1 ? "" : "s"}
        {done.updated > 0 && `, ${done.updated} existing one${done.updated === 1 ? "" : "s"} refreshed`}.
      </p>
      <ul className="mt-5 divide-y divide-ink/5 rounded-2xl border border-line">
        {done.groups.map((group) => (
          <li key={group.id} className="flex items-center gap-3 px-4 py-3">
            <span className="flex-1">{group.name}</span>
            <span className="font-mono text-[10px] uppercase tracking-[.12em] text-ink/40">{group.leads} rows</span>
            <Link to={`/leads?groupId=${group.id}`} className="font-mono text-[10px] uppercase tracking-[.12em] text-blue">
              Open →
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-5 flex gap-3">
        <Link
          to="/leads"
          className="inline-flex items-center gap-2 bg-ink px-4 py-2 font-mono text-xs uppercase tracking-[.12em] text-cream"
        >
          Go to leads
        </Link>
        <Button variant="secondary" onClick={onAgain}>
          Import another
        </Button>
      </div>
    </Card>
  );
}

function History({ history }: { history: LeadImportRecord[] }) {
  if (!history.length) return null;
  return (
    <section>
      <h2 className="mb-3 font-mono text-[11px] uppercase tracking-[.14em] text-ink/50">Recent imports</h2>
      <div className="overflow-x-auto rounded-2xl border border-line bg-white">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-ink/10 font-mono text-[10px] uppercase tracking-[.12em] text-ink/50">
              <th className="px-4 py-3">File</th>
              <th className="px-4 py-3">Read by</th>
              <th className="px-4 py-3">Tables</th>
              <th className="px-4 py-3">Leads</th>
              <th className="px-4 py-3">Batches</th>
              <th className="px-4 py-3">When</th>
            </tr>
          </thead>
          <tbody>
            {history.map((record) => (
              <tr key={record.id} className="border-b border-ink/5 last:border-0">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <StatusDot
                      tone={record.status === "IMPORTED" ? "ok" : record.status === "FAILED" ? "bad" : "warn"}
                    />
                    <span className="truncate">{record.fileName ?? "Spreadsheet"}</span>
                  </div>
                  {record.error && <p className="mt-1 text-xs text-red-600">{record.error}</p>}
                </td>
                <td className="px-4 py-3 text-xs text-ink/50">{record.analyzedBy === "rules" ? "Pattern rules" : record.analyzedBy}</td>
                <td className="px-4 py-3 text-xs text-ink/60">{record.tablesFound}</td>
                <td className="px-4 py-3 text-xs text-ink/60">
                  {record.leadsCreated}
                  {record.leadsUpdated > 0 && ` (+${record.leadsUpdated} updated)`}
                </td>
                <td className="px-4 py-3 text-xs">
                  <span className="flex flex-wrap gap-2">
                    {(record.groups ?? []).map((group) => (
                      <Link key={group.id} to={`/leads?groupId=${group.id}`} className="text-blue hover:underline">
                        {group.name}
                      </Link>
                    ))}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-ink/40">
                  <RelativeTime value={record.createdAt} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// --- Bits ------------------------------------------------------------------

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 font-mono text-[10px] uppercase tracking-[.12em] transition ${
        active ? "bg-ink text-cream" : "bg-ink/5 text-ink/50 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function Note({ tone, children }: { tone: "ok" | "warn" | "bad"; children: React.ReactNode }) {
  const styles = {
    ok: "border-emerald-200 bg-emerald-50 text-emerald-800",
    warn: "border-amber-200 bg-amber-50 text-amber-800",
    bad: "border-red-200 bg-red-50 text-red-700",
  }[tone];
  return <p className={`mb-4 border px-3 py-2 text-sm ${styles}`}>{children}</p>;
}
