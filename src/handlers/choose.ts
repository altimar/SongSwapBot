import type { Bot, Context } from "grammy";
import type { SwapRow } from "../db/types";
import type { BotDeps } from "../deps";
import { closeSwap, drawSummaryText, runDraw } from "../logic/swap";
import { addSongsToSwap, canAdminChat, rerunKeyboard } from "./shared";

// Обработка результата выбора свопа кнопкой: pick:<action>:<swapId>.
// Вызывается из общего callback-роутера в admin.ts.
export async function handlePick(
  bot: Bot,
  deps: BotDeps,
  ctx: Context,
  action: string,
  swap: SwapRow,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  const label = swap.title ?? "Без названия";

  if (action === "add") {
    if (swap.state !== "collecting") {
      await ctx.answerCallbackQuery("Приём в этом свопе уже закрыт").catch(() => {});
      return;
    }
    const text = await deps.repo.takePendingIntake(userId);
    await ctx.answerCallbackQuery().catch(() => {});
    if (text === null) {
      await ctx.reply("Не нашёл песен — пришли их ещё раз, пожалуйста");
      return;
    }
    await addSongsToSwap(ctx, deps, swap, text);
    return;
  }

  if (action === "leave") {
    if (swap.state !== "collecting") {
      await ctx.answerCallbackQuery("Приём закрыт — состав зафиксирован").catch(() => {});
      return;
    }
    if (!(await deps.repo.isParticipant(swap.id, userId))) {
      await ctx.answerCallbackQuery("Ты и так не участвуешь").catch(() => {});
      return;
    }
    await deps.repo.removeParticipant(swap.id, userId);
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.reply(`Готово: ты вышел из свопа «${label}», твои песни удалены 🫡`);
    return;
  }

  if (action === "close" || action === "draw") {
    if (!(await canAdminChat(bot.api, deps.adminIds, swap.chat_id, userId))) {
      await ctx.answerCallbackQuery("Доступно администраторам чата свопа").catch(() => {});
      return;
    }
    await ctx.answerCallbackQuery().catch(() => {});
    if (action === "close") {
      const text = await closeSwap(bot.api, deps.repo, swap, {
        actorId: userId,
        chatId: ctx.chat?.id ?? 0,
      });
      await ctx.editMessageText(text).catch(() => {
        void ctx.reply(text);
      });
      return;
    }
    if (swap.state === "closed") {
      const result = await runDraw(bot.api, deps.repo, swap);
      const text = result.ok ? drawSummaryText(result) : `Жеребьёвка не удалась: ${result.error}`;
      await ctx.editMessageText(text).catch(() => {
        void ctx.reply(text);
      });
    } else if (swap.state === "drawn") {
      await ctx
        .editMessageText(`Жеребьёвка «${label}» уже проведена — переразыграть?`, {
          reply_markup: rerunKeyboard(swap.id),
        })
        .catch(() => {});
    } else {
      await ctx.editMessageText("Сначала закрой приём песен: /close").catch(() => {});
    }
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
}
