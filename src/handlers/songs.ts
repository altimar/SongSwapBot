import type { Bot, Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { BotDeps } from "../deps";
import { addSongsToSwap, chooserKeyboard } from "./shared";

export function registerSongHandlers(bot: Bot, deps: BotDeps): void {
  bot.command("add", async (ctx) => {
    await routeIntake(bot, ctx, deps, typeof ctx.match === "string" ? ctx.match : "", true);
  });

  // Свободный текст в личке = песни; в группе ловим только явные упоминания бота
  // (privacy mode включён, остальной шум группы до нас и так не доходит).
  bot.on("message:text", async (ctx, next) => {
    const msg = ctx.msg;
    if (!msg) return next();
    if (ctx.chat.type === "private") {
      if (msg.text.startsWith("/")) return next();
      await routeIntake(bot, ctx, deps, msg.text, false);
      return;
    }
    const mention = findBotMention(msg.text, msg.entities ?? [], bot);
    if (!mention) return next();
    const payload = (msg.text.slice(0, mention.offset) + msg.text.slice(mention.offset + mention.length)).trim();
    await routeIntake(bot, ctx, deps, payload, true);
  });
}

interface MentionSpan {
  offset: number;
  length: number;
}

function findBotMention(text: string, entities: MessageEntity[], bot: Bot): MentionSpan | null {
  const info = bot.botInfo;
  if (!info) return null;
  for (const entity of entities) {
    if (entity.type === "mention") {
      const mention = text.slice(entity.offset, entity.offset + entity.length).toLowerCase();
      if (mention === `@${info.username.toLowerCase()}`) {
        return { offset: entity.offset, length: entity.length };
      }
    } else if (entity.type === "text_mention" && entity.user.id === info.id) {
      return { offset: entity.offset, length: entity.length };
    }
  }
  return null;
}

// Маршрутизация заявки: группа → своп этой группы; личка → единственный подходящий
// своп или кнопки выбора, когда открытых свопов несколько.
async function routeIntake(bot: Bot, ctx: Context, deps: BotDeps, raw: string, explicit: boolean): Promise<void> {
  const from = ctx.from;
  if (!from || !ctx.chat) return;

  if (explicit && !raw.trim()) {
    await ctx.reply(
      "Пришли песни — по одной на строку, например:\n/add Король и Шут — Лесник\nКукла колдуна",
    );
    return;
  }

  if (ctx.chat.type !== "private") {
    const swap = await deps.repo.getSwapByChat(ctx.chat.id);
    if (!swap) {
      if (explicit) await ctx.reply("Здесь нет активного свопа. Админ может открыть его: /newswap");
      return;
    }
    if (swap.mode === "secret") {
      const username = bot.botInfo?.username;
      if (explicit) {
        await ctx.reply(
          `🤫 Это секретный своп — песни принимаю только в личке${username ? ` (@${username})` : ""}: просто пришли их текстом, по одной на строку.`,
        );
      }
      return;
    }
    await addSongsToSwap(ctx, deps, swap, raw);
    return;
  }

  // Личка. Приоритет: свопы, где человек уже участвует (вторая и следующие песни);
  // затем все открытые свопы (и публичные, и секретные — членство всё равно проверяется).
  const mine = await deps.repo.getParticipatingSwaps(from.id, "collecting");
  const candidates = mine.length > 0 ? mine : await deps.repo.listSwaps(["collecting"]);
  if (candidates.length === 0) {
    await ctx.reply("Открытых свопов нет. Админ может открыть новый: /newswap");
    return;
  }

  if (candidates.length === 1) {
    await addSongsToSwap(ctx, deps, candidates[0], raw);
    return;
  }
  // Несколько кандидатов: прячем текст в pending_intake и спрашиваем кнопкой.
  await deps.repo.savePendingIntake(from.id, raw);
  await ctx.reply("Открыто несколько свопов — куда добавить песни?", {
    reply_markup: chooserKeyboard("add", candidates),
  });
}
