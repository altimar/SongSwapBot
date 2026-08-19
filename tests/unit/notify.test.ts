import { describe, expect, it } from "vitest";
import type { Api } from "grammy";
import { plural, sendLongText, sendSafe } from "../../src/logic/notify";

describe("plural — русские плюрализации", () => {
  const cases: [number, string][] = [
    [1, "песня"], [2, "песни"], [3, "песни"], [4, "песни"], [5, "песен"],
    [11, "песен"], [12, "песен"], [20, "песен"],
    [21, "песня"], [22, "песни"], [25, "песен"],
    [100, "песен"], [101, "песня"], [111, "песен"], [112, "песен"], [122, "песни"],
  ];
  for (const [n, expected] of cases) {
    it(`${n} → ${expected}`, () => {
      expect(plural(n, "песня", "песни", "песен")).toBe(expected);
    });
  }
});

describe("sendSafe — ошибки отправки не бросаются", () => {
  it("возвращает false при ошибке API", async () => {
    const api = { sendMessage: async () => { throw new Error("403"); } } as unknown as Api;
    await expect(sendSafe(api, 1, "текст")).resolves.toBe(false);
  });

  it("возвращает true при успехе", async () => {
    const api = { sendMessage: async () => ({}) } as unknown as Api;
    await expect(sendSafe(api, 1, "текст")).resolves.toBe(true);
  });
});

describe("sendLongText — нарезка длинных сообщений", () => {
  it("режет по строкам, каждый кусок ≤ 4000, всё доставлено", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `строка номер ${i} —`.padEnd(100, "x"));
    const text = lines.join("\n");
    const sent: string[] = [];
    const api = {
      sendMessage: async (_chatId: number, body: string) => {
        sent.push(body);
        return {};
      },
    } as unknown as Api;

    await sendLongText(api, 42, text);

    expect(sent.length).toBeGreaterThan(1);
    for (const chunk of sent) expect(chunk.length).toBeLessThanOrEqual(4000);
    const delivered = sent.join("\n");
    for (const line of lines) expect(delivered).toContain(line.slice(0, 30));
  });

  it("короткий текст уходит одним сообщением", async () => {
    const sent: string[] = [];
    const api = {
      sendMessage: async (_chatId: number, body: string) => {
        sent.push(body);
        return {};
      },
    } as unknown as Api;
    await sendLongText(api, 1, "коротко");
    expect(sent).toEqual(["коротко"]);
  });
});
