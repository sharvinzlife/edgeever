// A calendar entry is an ordinary note tagged with its local date, e.g. "2026-09-27".
export const DATE_TAG_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const CALENDAR_NOTEBOOK_NAME = "Calendar";
export const CALENDAR_TAG = "calendar";

const pad = (value: number) => String(value).padStart(2, "0");

export const toDateTag = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const parseDateTag = (tag: string): Date | null => {
  if (!DATE_TAG_PATTERN.test(tag)) return null;
  const [year, month, day] = tag.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
};

export const addDays = (date: Date, days: number): Date =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);

export const addMonths = (date: Date, months: number): Date => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
};

// Six Sunday-first weeks covering the month of `anchor`.
export const monthGrid = (anchor: Date): Date[] => {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = addDays(first, -first.getDay());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
};

export const CALENDAR_NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"] as const;
export type CalendarNavKey = (typeof CALENDAR_NAV_KEYS)[number];

export const isCalendarNavKey = (key: string): key is CalendarNavKey =>
  (CALENDAR_NAV_KEYS as readonly string[]).includes(key);

export const moveDate = (date: Date, key: CalendarNavKey): Date => {
  switch (key) {
    case "ArrowLeft": return addDays(date, -1);
    case "ArrowRight": return addDays(date, 1);
    case "ArrowUp": return addDays(date, -7);
    case "ArrowDown": return addDays(date, 7);
    case "PageUp": return addMonths(date, -1);
    case "PageDown": return addMonths(date, 1);
    case "Home": return addDays(date, -date.getDay());
    case "End": return addDays(date, 6 - date.getDay());
  }
};

// Entry counts per date tag, from the workspace tag list.
export const countDateTags = (tags: ReadonlyArray<{ name: string; memoCount: number }>): Map<string, number> =>
  new Map(tags.filter((tag) => parseDateTag(tag.name) !== null).map((tag) => [tag.name, tag.memoCount]));
