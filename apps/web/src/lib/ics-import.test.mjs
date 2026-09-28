import { describe, expect, test } from "bun:test";
import { icsEventToDraft, parseIcs } from "./ics-import.ts";

const buildIcs = (...events) =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    ...events.flatMap((event) => ["BEGIN:VEVENT", ...event, "END:VEVENT"]),
    "END:VCALENDAR",
  ].join("\r\n");

describe("ics import", () => {
  test("imports a timed event with a folded location", () => {
    const text = buildIcs([
      "UID:dentist",
      "DTSTART;TZID=America/New_York:20260930T093000",
      "DTEND;TZID=America/New_York:20260930T103000",
      "SUMMARY:Dentist\\, Dr. X",
      "LOCATION:Main\r\n  St",
    ]);
    const events = parseIcs(text);
    expect(events).toHaveLength(1);
    const draft = icsEventToDraft(events[0]);
    expect(draft.title).toBe("09:30 Dentist, Dr. X");
    expect(draft.tags).toEqual(["2026-09-30", "calendar"]);
    expect(draft.contentMarkdown).toBe("Location: Main St");
  });

  test("spreads an all-day event across its days and notes the recurrence", () => {
    const text = buildIcs([
      "UID:conf",
      "DTSTART;VALUE=DATE:20261001",
      "DTEND;VALUE=DATE:20261004",
      "RRULE:FREQ=YEARLY",
      "SUMMARY:Conference",
    ]);
    const draft = icsEventToDraft(parseIcs(text)[0]);
    expect(draft.tags).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "calendar"]);
    expect(draft.contentMarkdown).toContain("only the first date was imported");
  });

  test("uses a single date tag for an all-day event without DTEND", () => {
    const text = buildIcs(["DTSTART;VALUE=DATE:20261001", "SUMMARY:Holiday"]);
    const draft = icsEventToDraft(parseIcs(text)[0]);
    expect(draft.tags).toEqual(["2026-10-01", "calendar"]);
  });

  test("does not extend a timed event that ends exactly at midnight", () => {
    const text = buildIcs(["DTSTART:20261001T220000", "DTEND:20261002T000000", "SUMMARY:Late show"]);
    const draft = icsEventToDraft(parseIcs(text)[0]);
    expect(draft.tags).toEqual(["2026-10-01", "calendar"]);
  });

  test("caps a very long event at the maximum number of days", () => {
    const text = buildIcs(["DTSTART;VALUE=DATE:20261001", "DTEND;VALUE=DATE:20261111", "SUMMARY:Sabbatical"]);
    const draft = icsEventToDraft(parseIcs(text)[0]);
    expect(draft.tags).toHaveLength(15);
    expect(draft.tags).toEqual([
      "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
      "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-10",
      "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "calendar",
    ]);
  });

  test("skips an event without a start and titles an untitled one", () => {
    expect(parseIcs(buildIcs(["SUMMARY:Orphan"]))).toHaveLength(0);
    const draft = icsEventToDraft(parseIcs(buildIcs(["DTSTART;VALUE=DATE:20261001"]))[0]);
    expect(draft.title).toContain("(untitled event)");
  });
});
