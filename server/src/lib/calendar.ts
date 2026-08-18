import { GOOGLE_SCOPE, GoogleError, googleAuthorizedFetch, googleConnected, hasGoogleScope } from "./google.js";
import { SETTING, getSetting } from "./settings.js";

/**
 * Google Calendar — booking consultations and reading who is free.
 *
 * Rides on the Google connection that already exists for Drive and Sheets
 * rather than asking for a second one: one OAuth client, one consent screen,
 * one "Connect Google" button. The cost of that decision is that a connection
 * made before Calendar existed doesn't carry the scope, which `calendarReady`
 * reports honestly instead of discovering at the moment of booking.
 *
 * The calendar written to is whichever one the Owner names in Settings, or
 * `primary`. Naming it matters once there is a shared "Consultations" calendar
 * the team can all see, which is the point at which an agent booking something
 * stops being invisible to everyone else.
 */

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";

export interface CalendarReadiness {
  connected: boolean;
  /** False when the connection predates the Calendar scope and needs redoing. */
  scoped: boolean;
  calendarId: string;
}

export async function calendarId(): Promise<string> {
  return (await getSetting(SETTING.GOOGLE_CALENDAR_ID))?.trim() || "primary";
}

export async function calendarReady(): Promise<CalendarReadiness> {
  const [connected, scoped, id] = await Promise.all([googleConnected(), hasGoogleScope(GOOGLE_SCOPE.CALENDAR), calendarId()]);
  return { connected, scoped, calendarId: id };
}

export async function calendarConfigured(): Promise<boolean> {
  const ready = await calendarReady();
  return ready.connected && ready.scoped;
}

function assertUsable(ready: CalendarReadiness) {
  if (!ready.connected) throw new GoogleError(503, "Google isn't connected. Connect the account under Settings → Google.");
  if (!ready.scoped) {
    throw new GoogleError(
      403,
      "The Google account was connected before calendar access was added. Reconnect it under Settings → Google to grant it.",
    );
  }
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start: string | null;
  end: string | null;
  /** True for an all-day entry, which has a date rather than a timestamp. */
  allDay: boolean;
  attendees: string[];
  location: string | null;
  url: string | null;
  status: string;
}

function toEvent(raw: any): CalendarEvent {
  const start = raw.start?.dateTime ?? raw.start?.date ?? null;
  const end = raw.end?.dateTime ?? raw.end?.date ?? null;
  return {
    id: raw.id,
    title: raw.summary ?? "(no title)",
    description: raw.description ?? null,
    start,
    end,
    allDay: Boolean(raw.start?.date && !raw.start?.dateTime),
    attendees: (raw.attendees ?? []).map((attendee: any) => attendee.email).filter(Boolean),
    location: raw.location ?? null,
    url: raw.htmlLink ?? null,
    status: raw.status ?? "confirmed",
  };
}

/** What is in the diary between two moments. */
export async function listEvents(from: Date, to: Date, limit = 50): Promise<CalendarEvent[]> {
  const ready = await calendarReady();
  assertUsable(ready);

  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(ready.calendarId)}/events`);
  url.searchParams.set("timeMin", from.toISOString());
  url.searchParams.set("timeMax", to.toISOString());
  // Recurring events come back as their series unless this is set, which makes
  // "is Tuesday afternoon free" unanswerable.
  url.searchParams.set("singleEvents", "true");
  url.searchParams.set("orderBy", "startTime");
  url.searchParams.set("maxResults", String(Math.min(limit, 250)));

  const payload = await googleAuthorizedFetch<{ items?: any[] }>(url.toString());
  return (payload.items ?? []).map(toEvent);
}

export interface BusySlot {
  start: string;
  end: string;
}

/** The blocked-out parts of a window, which is all that is needed to offer a time. */
export async function busyPeriods(from: Date, to: Date): Promise<BusySlot[]> {
  const ready = await calendarReady();
  assertUsable(ready);

  const payload = await googleAuthorizedFetch<{ calendars?: Record<string, { busy?: BusySlot[]; errors?: { reason: string }[] }> }>(
    `${CALENDAR_API}/freeBusy`,
    {
      method: "POST",
      body: { timeMin: from.toISOString(), timeMax: to.toISOString(), items: [{ id: ready.calendarId }] },
    },
  );

  const calendar = payload.calendars?.[ready.calendarId];
  if (calendar?.errors?.length) {
    throw new GoogleError(403, `Google couldn't read that calendar: ${calendar.errors[0].reason}`);
  }
  return calendar?.busy ?? [];
}

export interface NewEvent {
  title: string;
  start: Date;
  end: Date;
  description?: string | null;
  location?: string | null;
  /** Invitees. Google emails them, so this is an outward-facing action. */
  attendees?: string[];
  timezone?: string;
}

/**
 * Books something. The one Google call in this app that a person on the other
 * side can see — an invitation lands in their inbox — which is why the tool
 * layer treats it as an outward-facing action and holds it behind dry run.
 */
export async function createEvent(event: NewEvent): Promise<CalendarEvent> {
  const ready = await calendarReady();
  assertUsable(ready);

  if (event.end <= event.start) throw new GoogleError(400, "The end of the meeting has to be after the start.");

  const body = {
    summary: event.title,
    description: event.description ?? undefined,
    location: event.location ?? undefined,
    start: { dateTime: event.start.toISOString(), timeZone: event.timezone ?? "Africa/Accra" },
    end: { dateTime: event.end.toISOString(), timeZone: event.timezone ?? "Africa/Accra" },
    attendees: event.attendees?.length ? event.attendees.map((email) => ({ email })) : undefined,
  };

  const url = new URL(`${CALENDAR_API}/calendars/${encodeURIComponent(ready.calendarId)}/events`);
  // Without this Google creates the event but tells nobody about it, which
  // looks identical from here and completely different to the invitee.
  if (event.attendees?.length) url.searchParams.set("sendUpdates", "all");

  return toEvent(await googleAuthorizedFetch<any>(url.toString(), { method: "POST", body }));
}

/** The calendars the connected account can see, for the picker in Settings. */
export async function listCalendars(): Promise<Array<{ id: string; name: string; primary: boolean }>> {
  const ready = await calendarReady();
  assertUsable(ready);
  const payload = await googleAuthorizedFetch<{ items?: any[] }>(`${CALENDAR_API}/users/me/calendarList?maxResults=50`);
  return (payload.items ?? []).map((item) => ({
    id: item.id,
    name: item.summaryOverride ?? item.summary ?? item.id,
    primary: Boolean(item.primary),
  }));
}
