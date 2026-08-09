/**
 * Google Drive and Sheets, for importing a lead sheet without downloading it
 * first.
 *
 * Read-only throughout: the Owner connects a Google account once, then picks a
 * spreadsheet from a list instead of exporting, downloading and re-uploading.
 * Only the refresh token is stored (encrypted, like the Apify token); access
 * tokens are minted per hour in memory and never persisted.
 *
 * Deliberately not the `googleapis` package — the six calls needed here are
 * plain HTTP, and a client library that pulls in every Google API for them is
 * not a trade worth making.
 */

import { SETTING, getSetting, setSetting } from "./settings.js";
import { MAX_COLUMNS, MAX_ROWS_PER_SHEET, parseWorkbook, toGrid, type SheetGrid } from "../services/spreadsheet.js";
import { columnLetter } from "../services/sheetPlan.js";

const OAUTH_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";

/** Read-only, and nothing beyond what picking and reading a sheet needs. */
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export const GOOGLE_SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const CSV_MIME = "text/csv";

export class GoogleError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "GoogleError";
    this.status = status;
  }
}

export class GoogleNotConnectedError extends GoogleError {
  constructor(message = "Google Drive isn't connected. Connect it under Lead capture → Connections.") {
    super(503, message);
    this.name = "GoogleNotConnectedError";
  }
}

// --- Configuration ---------------------------------------------------------

export async function googleCredentials(): Promise<{ clientId: string | null; clientSecret: string | null }> {
  const [clientId, clientSecret] = await Promise.all([
    getSetting(SETTING.GOOGLE_CLIENT_ID),
    getSetting(SETTING.GOOGLE_CLIENT_SECRET),
  ]);
  return { clientId, clientSecret };
}

export async function googleConfigured(): Promise<boolean> {
  const { clientId, clientSecret } = await googleCredentials();
  return Boolean(clientId && clientSecret);
}

export async function googleConnected(): Promise<boolean> {
  return Boolean(await getSetting(SETTING.GOOGLE_REFRESH_TOKEN));
}

/**
 * The URL Google must redirect back to. It has to match a "Authorised redirect
 * URI" on the OAuth client exactly, so the settings screen shows this value for
 * the Owner to paste into the Google Cloud console.
 */
export function redirectUri(origin: string): string {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || `${origin.replace(/\/$/, "")}/api/imports/google/callback`;
}

export async function buildAuthUrl(origin: string, state: string): Promise<string> {
  const { clientId } = await googleCredentials();
  if (!clientId) throw new GoogleError(400, "Add a Google OAuth client ID and secret before connecting.");

  const url = new URL(OAUTH_AUTH_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri(origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", SCOPES.join(" "));
  // Without both of these Google returns no refresh token on a repeat consent,
  // and the connection silently dies an hour later.
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "true");
  url.searchParams.set("state", state);
  return url.toString();
}

// --- Tokens ----------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  token_type?: string;
}

async function postToken(body: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    const detail = (payload.error_description ?? payload.error ?? response.statusText) as string;
    throw new GoogleError(response.status, `Google rejected the sign-in: ${detail}`);
  }
  return payload as unknown as TokenResponse;
}

/** One process, one access token. Refreshed a minute before it actually expires. */
let accessTokenCache: { token: string; expiresAt: number } | null = null;

export function clearGoogleTokenCache() {
  accessTokenCache = null;
}

/** Completes the consent redirect and stores the refresh token. */
export async function exchangeCode(code: string, origin: string): Promise<{ email: string | null }> {
  const { clientId, clientSecret } = await googleCredentials();
  if (!clientId || !clientSecret) throw new GoogleError(400, "Google OAuth client ID and secret are not set.");

  const tokens = await postToken({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });

  if (!tokens.refresh_token) {
    throw new GoogleError(
      400,
      "Google didn't return a refresh token. Remove Dakyworld OS from your Google account's third-party access and connect again.",
    );
  }

  await setSetting(SETTING.GOOGLE_REFRESH_TOKEN, tokens.refresh_token, { secret: true });
  accessTokenCache = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000 };

  const email = await fetchEmail(tokens.access_token);
  if (email) await setSetting(SETTING.GOOGLE_ACCOUNT, email);
  return { email };
}

async function fetchEmail(token: string): Promise<string | null> {
  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { email?: string };
    return payload.email ?? null;
  } catch {
    return null;
  }
}

async function accessToken(): Promise<string> {
  if (accessTokenCache && accessTokenCache.expiresAt > Date.now()) return accessTokenCache.token;

  const [refreshToken, { clientId, clientSecret }] = await Promise.all([
    getSetting(SETTING.GOOGLE_REFRESH_TOKEN),
    googleCredentials(),
  ]);
  if (!refreshToken) throw new GoogleNotConnectedError();
  if (!clientId || !clientSecret) throw new GoogleError(400, "Google OAuth client ID and secret are not set.");

  const tokens = await postToken({
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
  });
  accessTokenCache = { token: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000 - 60_000 };
  return tokens.access_token;
}

async function apiGet<T>(url: string): Promise<T> {
  const token = await accessToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  if (!response.ok) {
    const detail = await response
      .json()
      .then((body: any) => body?.error?.message)
      .catch(() => null);
    if (response.status === 401 || response.status === 403) {
      accessTokenCache = null;
      throw new GoogleError(403, detail ?? "Google denied access. Reconnect the account under Lead capture → Connections.");
    }
    throw new GoogleError(response.status, detail ?? `Google returned ${response.status}`);
  }
  return (await response.json()) as T;
}

// --- Drive -----------------------------------------------------------------

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  owners?: { displayName?: string }[];
  size?: string;
}

/** Escapes a value for a Drive `q` string literal. */
function escapeQuery(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** Spreadsheets the connected account can see, newest first. */
export async function listSpreadsheets(search?: string, limit = 40): Promise<DriveFile[]> {
  const clauses = [
    `(mimeType='${GOOGLE_SHEET_MIME}' or mimeType='${XLSX_MIME}' or mimeType='${CSV_MIME}')`,
    "trashed=false",
  ];
  if (search?.trim()) clauses.push(`name contains '${escapeQuery(search.trim())}'`);

  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set("q", clauses.join(" and "));
  url.searchParams.set("orderBy", "modifiedTime desc");
  url.searchParams.set("pageSize", String(Math.min(limit, 100)));
  url.searchParams.set("fields", "files(id,name,mimeType,modifiedTime,webViewLink,size,owners(displayName))");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");

  const payload = await apiGet<{ files?: DriveFile[] }>(url.toString());
  return payload.files ?? [];
}

export async function getDriveFile(fileId: string): Promise<DriveFile> {
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("fields", "id,name,mimeType,modifiedTime,webViewLink,size");
  url.searchParams.set("supportsAllDrives", "true");
  return apiGet<DriveFile>(url.toString());
}

async function downloadDriveFile(fileId: string): Promise<Buffer> {
  const token = await accessToken();
  const url = new URL(`${DRIVE_API}/files/${encodeURIComponent(fileId)}`);
  url.searchParams.set("alt", "media");
  url.searchParams.set("supportsAllDrives", "true");

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new GoogleError(response.status, `Could not download that file from Drive (${response.status}).`);
  return Buffer.from(await response.arrayBuffer());
}

// --- Sheets ----------------------------------------------------------------

interface SpreadsheetMeta {
  properties?: { title?: string };
  sheets?: { properties?: { title?: string; gridProperties?: { rowCount?: number; columnCount?: number } } }[];
}

/** The tab names in a spreadsheet, whatever format it is stored in. */
export async function listTabs(file: DriveFile): Promise<string[]> {
  if (file.mimeType === GOOGLE_SHEET_MIME) {
    const url = new URL(`${SHEETS_API}/${encodeURIComponent(file.id)}`);
    url.searchParams.set("fields", "sheets.properties.title");
    const meta = await apiGet<SpreadsheetMeta>(url.toString());
    return (meta.sheets ?? []).map((sheet) => sheet.properties?.title ?? "").filter(Boolean);
  }

  if (file.mimeType === CSV_MIME) return [file.name.replace(/\.[^.]+$/, "")];

  const buffer = await downloadDriveFile(file.id);
  const grids = await parseWorkbook(buffer, file.name);
  return grids.map((grid) => grid.name);
}

/** `'My sheet'!A1:BH5000`, with the quote escaping Sheets ranges require. */
function rangeFor(title: string): string {
  const escaped = title.replace(/'/g, "''");
  return `'${escaped}'!A1:${columnLetter(MAX_COLUMNS - 1)}${MAX_ROWS_PER_SHEET}`;
}

/**
 * Reads the chosen tabs into grids. Native Google Sheets come straight from the
 * Sheets API — no export, no re-parse — while an `.xlsx` or `.csv` sitting in
 * Drive is downloaded and read by the same parser an upload would use.
 */
export async function readGrids(fileId: string, sheetNames?: string[]): Promise<{ file: DriveFile; grids: SheetGrid[] }> {
  const file = await getDriveFile(fileId);

  if (file.mimeType !== GOOGLE_SHEET_MIME) {
    const buffer = await downloadDriveFile(file.id);
    return { file, grids: await parseWorkbook(buffer, file.name, sheetNames) };
  }

  const titles = sheetNames?.length ? sheetNames : await listTabs(file);
  if (!titles.length) return { file, grids: [] };

  const url = new URL(`${SHEETS_API}/${encodeURIComponent(fileId)}/values:batchGet`);
  for (const title of titles) url.searchParams.append("ranges", rangeFor(title));
  // Formatted values are what the Owner sees in the browser — including dates
  // and currency — which is the reading the analyst should be shown too.
  url.searchParams.set("valueRenderOption", "FORMATTED_VALUE");
  url.searchParams.set("dateTimeRenderOption", "FORMATTED_STRING");
  url.searchParams.set("majorDimension", "ROWS");

  const payload = await apiGet<{ valueRanges?: { range?: string; values?: string[][] }[] }>(url.toString());
  const grids = (payload.valueRanges ?? [])
    .map((valueRange, index) => toGrid(titles[index] ?? `Sheet ${index + 1}`, valueRange.values ?? []))
    .filter((grid) => grid.rows.length > 0);

  return { file, grids };
}
