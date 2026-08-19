import type { Bot } from "grammy";
import type { BotDeps } from "../deps";

export function registerMiscHandlers(bot: Bot, deps: BotDeps): void {
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    await ctx.reply(
      [
        "Привет! Я бот караоке-свопов 🎤",
        "",
        "Механика: админ открывает своп, каждый приносит несколько песен, а жеребьёвка случайно решает, кто какую чужую песню поёт.",
        "",
        "Чтобы участвовать — просто пришли мне песни текстом, по одной на строку. Например:",
        "Король и Шут — Лесник",
        "Ария — Беспечный ангел",
        "",
        "Команды: /help",
      ].join("\n"),
    );
  });

  bot.command("help", async (ctx) => {
    const isAdmin = ctx.from !== undefined && deps.adminIds.has(ctx.from.id);
    await ctx.reply(
      [
        "🎤 Как устроен своп:",
        "Админ открывает своп → все скидывают песни → жеребьёвка случайно решает, кто какую песню поёт.",
        "",
        "Команды:",
        "• просто пришли песни текстом (по одной на строку) — или /add Король и Шут — Лесник",
        "• /status — участники и песни (в личке с ботом)",
        "• /leave — выйти из свопа",
        ...(isAdmin
          ? [
              "",
              "Админам (в групповом чате):",
              "• /newswap [название] — открыть публичный своп (старый удалится)",
              "• /newsecret [название] — открыть секретный своп (песни скрыты до жеребьёвки)",
              "• /close — закрыть приём песен",
              "• /draw — жеребьёвка (повторно — перерозыгрыш)",
            ]
          : []),
      ].join("\n"),
    );
  });

  // Финальный catch-all: сюда падает всё, что не съели хендлеры выше.
  bot.on("message", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (typeof ctx.msg.text === "string") {
      if (ctx.msg.text.startsWith("/")) {
        await ctx.reply("Не знаю такую команду. Список команд: /help");
      }
      return;
    }
    await ctx.reply("Песни принимаю только текстом, по одной на строку 🙏");
  });
}
