import type { Bot, Context } from "grammy";
import type { SwapMode, SwapRow } from "../db/types";
import type { BotDeps } from "../deps";
import { closeSwap, drawSummaryText, runDraw } from "../logic/swap";
import { handlePick } from "./choose";
import { chooserKeyboard, rerunKeyboard } from "./shared";

const NEW_SWAP_CALLBACK = "newswap:"; // newswap:<mode>:<title>
const MAX_CALLBACK_DATA_BYTES = 64;

export function registerAdminHandlers(bot: Bot, deps: BotDeps): void {
  bot.command("newswap", async (ctx) => {
    await startSwapCommand(bot, deps, ctx, "public");
  });

  bot.command("newsecret", async (ctx) => {
    await startSwapCommand(bot, deps, ctx, "secret");
  });

  bot.command("close", async (ctx) => {
    if (!(await requireAdmin(ctx, deps))) return;
    const candidates = ctx.chat.type === "private"
      ? await deps.repo.listSwaps(["collecting"])
      : swapOrNil(await deps.repo.getSwapByChat(ctx.chat.id));
    if (candidates.length === 0) {
      await ctx.reply(
        ctx.chat.type === "private"
          ? "Нет свопов с открытым приёмом."
          : "В этой группе нет активного свопа — сначала /newswap.",
      );
      return;
    }
    if (candidates.length > 1) {
      await ctx.reply("Какой своп закрыть?", { reply_markup: chooserKeyboard("close", candidates) });
      return;
    }
    const text = await closeSwap(bot.api, deps.repo, candidates[0], {
      actorId: ctx.from!.id,
      chatId: ctx.chat.id,
    });
    await ctx.reply(text);
  });

  bot.command("draw", async (ctx) => {
    if (!(await requireAdmin(ctx, deps))) return;
    const candidates = ctx.chat.type === "private"
      ? await deps.repo.listSwaps(["closed", "drawn"])
      : swapOrNil(await deps.repo.getSwapByChat(ctx.chat.id));
    if (candidates.length === 0) {
      await ctx.reply(
        ctx.chat.type === "private"
          ? "Нет свопов, готовых к жеребьёвке (нужны /newswap и /close)."
          : "В этой группе нет активного свопа — сначала /newswap.",
      );
      return;
    }
    if (candidates.length > 1) {
      await ctx.reply("Какой своп разыграть?", { reply_markup: chooserKeyboard("draw", candidates) });
      return;
    }
    await drawCommandFlow(bot, deps, ctx, candidates[0]);
  });

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data === "admin:cancel") {
      await ctx.answerCallbackQuery("Отменено").catch(() => {});
      await ctx.editMessageText("Отменено ❌").catch(() => {});
      return;
    }

    if (data.startsWith("draw:") && data.endsWith(":rerun")) {
      if (!deps.adminIds.has(ctx.callbackQuery.from.id)) {
        await ctx.answerCallbackQuery("Кнопки только для админов").catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery("Переразыгрываю…").catch(() => {});
      const swapId = Number(data.slice("draw:".length, -":rerun".length));
      const swap = Number.isInteger(swapId) ? await deps.repo.getSwapById(swapId) : null;
      if (!swap || swap.state !== "drawn") {
        await ctx.editMessageText("Своп уже не в состоянии розыгрыша.").catch(() => {});
        return;
      }
      const result = await runDraw(bot.api, deps.repo, swap);
      const text = result.ok ? drawSummaryText(result) : `Жеребьёвка не удалась: ${result.error}`;
      await ctx.editMessageText(text).catch(() => {
        void ctx.reply(text);
      });
      return;
    }

    if (data.startsWith(NEW_SWAP_CALLBACK)) {
      if (!deps.adminIds.has(ctx.callbackQuery.from.id)) {
        await ctx.answerCallbackQuery("Кнопки только для админов").catch(() => {});
        return;
      }
      const chat = ctx.callbackQuery.message?.chat;
      if (!chat || chat.type === "private") {
        await ctx.answerCallbackQuery("Своп открывается в групповом чате").catch(() => {});
        return;
      }
      // Режим и название тащим в callback_data: newswap:<mode>:<title>
      const rest = data.slice(NEW_SWAP_CALLBACK.length);
      const sep = rest.indexOf(":");
      const mode = sep >= 0 ? rest.slice(0, sep) : "";
      const title = sep >= 0 ? rest.slice(sep + 1).trim() || null : null;
      if (mode !== "public" && mode !== "secret") {
        await ctx.answerCallbackQuery("Не поняла команду").catch(() => {});
        return;
      }
      await ctx.answerCallbackQuery().catch(() => {});
      await deps.repo.createSwap(mode, chat.id, title);
      await ctx
        .editMessageText(welcomeText(mode, title, bot.botInfo?.username))
        .catch(() => {});
      return;
    }

    if (data.startsWith("pick:")) {
      const [, action, idStr] = data.split(":");
      const swapId = Number(idStr);
      const swap = Number.isInteger(swapId) ? await deps.repo.getSwapById(swapId) : null;
      if (!swap) {
        await ctx.answerCallbackQuery("Этот своп уже удалён").catch(() => {});
        return;
      }
      await handlePick(bot, deps, ctx, action, swap);
      return;
    }

    await ctx.answerCallbackQuery().catch(() => {});
  });
}

function swapOrNil(swap: SwapRow | null): SwapRow[] {
  return swap ? [swap] : [];
}

async function drawCommandFlow(bot: Bot, deps: BotDeps, ctx: Context, swap: SwapRow): Promise<void> {
  if (swap.state === "collecting") {
    await ctx.reply("Сначала закрой приём песен: /close");
    return;
  }
  if (swap.state === "drawn") {
    const label = swap.title ?? "Без названия";
    await ctx.reply(`Жеребьёвка «${label}» уже проведена — переразыграть?`, {
      reply_markup: rerunKeyboard(swap.id),
    });
    return;
  }
  const result = await runDraw(bot.api, deps.repo, swap);
  await ctx.reply(result.ok ? drawSummaryText(result) : `Жеребьёвка не удалась: ${result.error}`);
}

// Общий старт /newswap и /newsecret: оба режима создаются в группе и привязываются к ней.
async function startSwapCommand(bot: Bot, deps: BotDeps, ctx: Context, mode: SwapMode): Promise<void> {
  if (!(await requireAdmin(ctx, deps))) return;
  if (!ctx.chat) return;
  if (ctx.chat.type === "private") {
    await ctx.reply(
      "Свопы создаются в групповом чате: добавь меня в группу и там открой /newswap (публичный) или /newsecret (секретный).",
    );
    return;
  }
  const title = typeof ctx.match === "string" ? ctx.match.trim() : "";
  // Свопы живут по одному на чат: подтверждение нужно, только если в ЭТОМ чате своп уже есть.
  const existing = await deps.repo.getSwapByChat(ctx.chat.id);
  if (existing) {
    const existingTitle = existing.title ? ` «${existing.title}»` : "";
    // Название приходится тащить в callback_data — Telegram ограничивает её 64 байтами.
    const budget = MAX_CALLBACK_DATA_BYTES - (NEW_SWAP_CALLBACK.length + mode.length + 1);
    await ctx.reply(
      `В этом чате уже есть своп${existingTitle}. Открыть новый? Его участники, песни и жеребьёвка будут удалены безвозвратно.`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "✅ Открыть новый", callback_data: NEW_SWAP_CALLBACK + mode + ":" + truncateToBytes(title, budget) },
              { text: "Отмена", callback_data: "admin:cancel" },
            ],
          ],
        },
      },
    );
    return;
  }
  await createSwapFromContext(bot, deps, ctx, mode, title || null);
}

async function requireAdmin(ctx: Context, deps: BotDeps): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId !== undefined && deps.adminIds.has(userId)) return true;
  if (deps.adminIds.size === 0) {
    await ctx.reply("Бот не настроен: в ADMIN_IDS не указан ни один админ (см. README).");
  } else {
    await ctx.reply("Эта команда только для админов 🤫");
  }
  return false;
}

async function createSwapFromContext(
  bot: Bot,
  deps: BotDeps,
  ctx: Context,
  mode: SwapMode,
  title: string | null,
): Promise<void> {
  const chat = ctx.chat;
  if (!chat || chat.type === "private") return;
  await deps.repo.createSwap(mode, chat.id, title);
  await ctx.reply(welcomeText(mode, title, bot.botInfo?.username));
}

function welcomeText(mode: SwapMode, title: string | null, botUsername?: string): string {
  const titlePart = title ? ` «${title}»` : "";
  const howTo = botUsername ? `@${botUsername}` : "этот бот";
  const multiHint = "Если открыто несколько свопов, при отправке песен в личке бот уточнит кнопкой, куда их положить.";
  if (mode === "public") {
    return [
      `🎵 Своп${titlePart} открыт — приём песен идёт!`,
      "",
      "Сдать песню может каждый:",
      "• /add Король и Шут — Лесник (можно несколько — по одной на строку)",
      `• или написать ${howTo} прямо в чате с песней`,
      "",
      "Первая песня автоматически делает участником. Участвовать могут только участники этого чата.",
      multiHint,
      "Админ: /close — закрыть приём, /draw — жеребьёвка.",
    ].join("\n");
  }
  return [
    `🤫 Секретный своп${titlePart} открыт — привязан к этому чату.`,
    "",
    `Участвовать могут только участники этого чата, но песни сдавайте мне в личке (${howTo}) — по одной на строку. Чужие песни никто не увидит до жеребьёвки, а жребий придёт каждому лично.`,
    multiHint,
    "",
    "Админ: /close — закрыть приём, /draw — жеребьёвка.",
  ].join("\n");
}

// Обрезаем по байтам (callback_data ≤ 64 байт), не ломая многобайтовые символы.
export function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  const cut = new TextDecoder().decode(bytes.slice(0, maxBytes));
  return cut.replace(/\uFFFD+$/, "");
}
