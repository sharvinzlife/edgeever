import { describe, expect, test } from "bun:test";
import { countDateTags, monthGrid, moveDate, parseDateTag, toDateTag } from "./calendar-dates.ts";

describe("calendar dates", () => {
  test("formats a date as a local date tag", () => {
    expect(toDateTag(new Date(2026, 8, 7))).toBe("2026-09-07");
  });

  test("rejects impossible and malformed date tags", () => {
    expect(parseDateTag("2026-02-30")).toBeNull();
    expect(parseDateTag("x")).toBeNull();
  });

  test("parses a valid date tag back to its date", () => {
    const parsed = parseDateTag("2026-09-27");
    expect(parsed).not.toBeNull();
    expect(parsed?.getFullYear()).toBe(2026);
    expect(parsed?.getMonth()).toBe(8);
    expect(parsed?.getDate()).toBe(27);
  });

  test("moves the selection with navigation keys", () => {
    expect(toDateTag(moveDate(new Date(2026, 8, 30), "ArrowRight"))).toBe("2026-10-01");
    expect(toDateTag(moveDate(new Date(2026, 8, 3), "ArrowUp"))).toBe("2026-08-27");
    expect(toDateTag(moveDate(new Date(2026, 0, 31), "PageDown"))).toBe("2026-02-28");
    expect(toDateTag(moveDate(new Date(2026, 8, 26), "Home"))).toBe("2026-09-20");
    expect(toDateTag(moveDate(new Date(2026, 8, 20), "End"))).toBe("2026-09-26");
  });

  test("builds a six-week grid covering the month", () => {
    const grid = monthGrid(new Date(2026, 8, 27));
    expect(grid).toHaveLength(42);
    expect(toDateTag(grid[0])).toBe("2026-08-30");
    expect(toDateTag(grid[41])).toBe("2026-10-10");
  });

  test("counts only date tags", () => {
    const counts = countDateTags([
      { name: "2026-09-27", memoCount: 2 },
      { name: "work", memoCount: 5 },
    ]);
    expect(counts).toEqual(new Map([["2026-09-27", 2]]));
  });
});
