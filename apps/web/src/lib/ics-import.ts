import { addDays, CALENDAR_TAG, toDateTag } from "./calendar-dates";

export type IcsEvent = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  start: Date;
  end: Date | null;
  allDay: boolean;
  recurrence: string;
};

export type CalendarDraft = {
  title: string;
  tags: string[];
  contentMarkdown: string;
};

// A multi-day event gets one date tag per day, capped so a stray year-long event
// cannot exceed EdgeEver's 24-tag limit.
export const MAX_EVENT_DAYS = 14;

const pad = (value: number) => String(value).padStart(2, "0");

const unfold = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "").split("\n");

const unescapeText = (value: string): string =>
  value.replace(/\\([nN,;\\])/g, (_, char: string) => (char === "n" || char === "N" ? "\n" : char));

// Returns null for a value this importer does not understand; the event is then skipped.
const parseIcsDate = (value: string, params: string): { date: Date; allDay: boolean } | null => {
  const allDay = /^\d{8}$/.exec(value);
  if (allDay || /VALUE=DATE(;|$)/i.test(params)) {
    const match = /^(\d{4})(\d{2})(\d{2})/.exec(value);
    if (!match) return null;
    return { date: new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])), allDay: true };
  }
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  // UTC times convert to the viewer's zone; TZID/floating times are kept as wall-clock time.
  const date = match[7] === "Z"
    ? new Date(Date.UTC(year, month - 1, day, hour, minute, second))
    : new Date(year, month - 1, day, hour, minute, second);
  return { date, allDay: false };
};

export const parseIcs = (text: string): IcsEvent[] => {
  const events: IcsEvent[] = [];
  let current: Record<string, { value: string; params: string }> | null = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
      continue;
    }
    if (line === "END:VEVENT") {
      const start = current?.DTSTART ? parseIcsDate(current.DTSTART.value, current.DTSTART.params) : null;
      if (current && start) {
        const end = current.DTEND ? parseIcsDate(current.DTEND.value, current.DTEND.params) : null;
        events.push({
          uid: current.UID?.value ?? "",
          summary: unescapeText(current.SUMMARY?.value ?? "").trim(),
          description: unescapeText(current.DESCRIPTION?.value ?? "").trim(),
          location: unescapeText(current.LOCATION?.value ?? "").trim(),
          start: start.date,
          end: end?.date ?? null,
          allDay: start.allDay,
          recurrence: current.RRULE?.value ?? "",
        });
      }
      current = null;
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const [name, ...params] = line.slice(0, colon).split(";");
    current[name.toUpperCase()] = { value: line.slice(colon + 1), params: params.join(";") };
  }
  return events;
};

export const eventDateTags = (event: IcsEvent): string[] => {
  const first = new Date(event.start.getFullYear(), event.start.getMonth(), event.start.getDate());
  let last = first;
  if (event.end) {
    const endDay = new Date(event.end.getFullYear(), event.end.getMonth(), event.end.getDate());
    const endsAtMidnight = event.end.getTime() === endDay.getTime();
    // All-day DTEND is exclusive; a timed event ending exactly at midnight does not touch that day.
    last = event.allDay || endsAtMidnight ? addDays(endDay, -1) : endDay;
  }
  const tags: string[] = [];
  for (let day = first; day <= last && tags.length < MAX_EVENT_DAYS; day = addDays(day, 1)) {
    tags.push(toDateTag(day));
  }
  return tags.length > 0 ? tags : [toDateTag(first)];
};

export const icsEventToDraft = (event: IcsEvent): CalendarDraft => {
  const summary = event.summary || "(untitled event)";
  const title = event.allDay ? summary : `${pad(event.start.getHours())}:${pad(event.start.getMinutes())} ${summary}`;
  const lines: string[] = [];
  if (event.location) lines.push(`Location: ${event.location}`);
  if (event.description) lines.push(event.description);
  if (event.recurrence) lines.push(`Repeats: ${event.recurrence} (only the first date was imported)`);
  return { title, tags: [...eventDateTags(event), CALENDAR_TAG], contentMarkdown: lines.join("\n\n") };
};
