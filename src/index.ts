import { webhookCallback, type Bot } from "grammy";
import { createBot } from "./bot";
import type { Env } from "./env";

interface CachedWorker {
  key: string;
  handle: (request: Request) => Promise<Response>;
}

let cached: CachedWorker | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("SongSwapBot is running");
    }
    if (request.method !== "POST" || url.pathname !== "/webhook") {
      return new Response("Not found", { status: 404 });
    }

    // Кешируем бота внутри изолята, чтобы не пересоздавать (и не звать getMe) на каждый апдейт.
    const key = `${env.BOT_TOKEN}|${env.WEBHOOK_SECRET}|${env.ADMIN_IDS}`;
    if (!cached || cached.key !== key) {
      const bot: Bot = createBot(env);
      cached = {
        key,
        handle: webhookCallback(bot, "cloudflare-mod", { secretToken: env.WEBHOOK_SECRET }),
      };
    }
    return cached.handle(request);
  },
};
