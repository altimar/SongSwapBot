import { describe, expect, it } from "vitest";
import { parseAdminIds } from "../../src/admin";
import { truncateToBytes } from "../../src/handlers/admin";

describe("parseAdminIds", () => {
  it("пустая строка — пустое множество", () => {
    expect(parseAdminIds("").size).toBe(0);
  });

  it("мусор и пустые элементы игнорируются", () => {
    expect(parseAdminIds("1, 2,,abc,3")).toEqual(new Set([1, 2, 3]));
  });

  it("один id", () => {
    expect(parseAdminIds("42")).toEqual(new Set([42]));
  });

  it("отрицательные и нецелые отбрасываются", () => {
    expect(parseAdminIds("-5, 3.5, 7")).toEqual(new Set([7]));
  });
});

describe("truncateToBytes — callback_data ≤ 64 байта", () => {
  it("короткая строка не трогается", () => {
    expect(truncateToBytes("abc", 10)).toBe("abc");
  });

  it("ASCII режется по байтам", () => {
    expect(truncateToBytes("abcdefgh", 5)).toBe("abcde");
  });

  it("кириллица режется по границе символа (2 байта на букву)", () => {
    // «абвгд» = 10 байт; бюджет 7 → «абв» (6 байт), битой половинки нет
    expect(truncateToBytes("абвгд", 7)).toBe("абв");
  });

  it("нулевой бюджет — пустая строка", () => {
    expect(truncateToBytes("абв", 0)).toBe("");
  });

  it("результат всегда помещается в бюджет", () => {
    const long = "тестовая строка".repeat(10);
    for (const budget of [1, 2, 3, 5, 8, 13]) {
      expect(new TextEncoder().encode(truncateToBytes(long, budget)).length).toBeLessThanOrEqual(budget);
    }
  });
});
