import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "./env";
import { parseAdminIds } from "./admin";
import { Repo } from "./db/repo";
import type { BotDeps } from "./deps";
import { registerAdminHandlers } from "./handlers/admin";
import { registerMiscHandlers } from "./handlers/misc";
import { registerSongHandlers } from "./handlers/songs";
import { registerStatusHandlers } from "./handlers/status";

export function createBot(env: Env): Bot {
  const bot = new Bot(env.BOT_TOKEN, {
    client: { apiRoot: env.TELEGRAM_API_ROOT ?? "https://api.telegram.org" },
  });
  if (env.BOT_INFO_JSON) {
    bot.botInfo = JSON.parse(env.BOT_INFO_JSON) as UserFromGetMe;
  }
  const deps: BotDeps = {
    repo: new Repo(env.DB),
    adminIds: parseAdminIds(env.ADMIN_IDS ?? ""),
  };
  // Ошибки логируем и проглатываем: возврат 500 заставил бы Telegram
  // доставить апдейт повторно и выполнить команду второй раз.
  bot.catch((err) => {
    console.error("update processing failed:", err.error);
  });
  registerAdminHandlers(bot, deps);
  registerSongHandlers(bot, deps);
  registerStatusHandlers(bot, deps);
  registerMiscHandlers(bot, deps);
  return bot;
}
