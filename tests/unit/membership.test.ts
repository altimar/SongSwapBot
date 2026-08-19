import { describe, expect, it } from "vitest";
import type { Api } from "grammy";
import { isChatAdmin, isChatMember } from "../../src/handlers/shared";

const apiWith = (status: string, extra: object = {}) =>
  ({ getChatMember: async () => ({ status, ...extra }) }) as unknown as Api;

describe("isChatMember — статусы Telegram", () => {
  it("member / administrator / creator — участник", async () => {
    for (const status of ["member", "administrator", "creator"]) {
      await expect(isChatMember(apiWith(status), -100, 1)).resolves.toBe(true);
    }
  });

  it("restricted считается по is_member", async () => {
    await expect(isChatMember(apiWith("restricted", { is_member: true }), -100, 1)).resolves.toBe(true);
    await expect(isChatMember(apiWith("restricted", { is_member: false }), -100, 1)).resolves.toBe(false);
  });

  it("left / kicked — не участник", async () => {
    for (const status of ["left", "kicked"]) {
      await expect(isChatMember(apiWith(status), -100, 1)).resolves.toBe(false);
    }
  });

  it("ошибка API трактуется как «не участник»", async () => {
    const api = { getChatMember: async () => { throw new Error("400"); } } as unknown as Api;
    await expect(isChatMember(api, -100, 1)).resolves.toBe(false);
  });
});

describe("isChatAdmin — права администратора чата", () => {
  it("administrator / creator — админ", async () => {
    for (const status of ["administrator", "creator"]) {
      await expect(isChatAdmin(apiWith(status), -100, 1)).resolves.toBe(true);
    }
  });

  it("member / restricted / left / kicked — не админ", async () => {
    for (const status of ["member", "restricted", "left", "kicked"]) {
      await expect(isChatAdmin(apiWith(status), -100, 1)).resolves.toBe(false);
    }
  });

  it("ошибка API трактуется как «не админ»", async () => {
    const api = { getChatMember: async () => { throw new Error("400"); } } as unknown as Api;
    await expect(isChatAdmin(api, -100, 1)).resolves.toBe(false);
  });
});
