import type { Bot } from "grammy";
import type { BotDeps } from "../deps";
import type { SwapState } from "../db/types";
import { plural, sendLongText } from "../logic/notify";
import { chooserKeyboard } from "./shared";

export function registerStatusHandlers(bot: Bot, deps: BotDeps): void {
  bot.command("leave", async (ctx) => {
    const from = ctx.from;
    if (!from) return;
    if (ctx.chat.type !== "private") {
      const swap = await deps.repo.getSwapByChat(ctx.chat.id);
      if (!swap) {
        await ctx.reply("В этой группе нет активного свопа.");
        return;
      }
      if (swap.state !== "collecting") {
        await ctx.reply("Приём закрыт, состав зафиксирован — выйти уже нельзя.");
        return;
      }
      if (!(await deps.repo.isParticipant(swap.id, from.id))) {
        await ctx.reply("Ты и так не участвуешь.");
        return;
      }
      await deps.repo.removeParticipant(swap.id, from.id);
      await ctx.reply("Готово: ты вышел из свопа, твои песни удалены 🫡");
      return;
    }

    const mine = await deps.repo.getParticipatingSwaps(from.id, "collecting");
    if (mine.length === 0) {
      await ctx.reply("Ты не участвуешь ни в одном свопе с открытым приёмом.");
      return;
    }
    if (mine.length === 1) {
      await deps.repo.removeParticipant(mine[0].id, from.id);
      await ctx.reply("Готово: ты вышел из свопа, твои песни удалены 🫡");
      return;
    }
    await ctx.reply("Из какого свопа выйти?", { reply_markup: chooserKeyboard("leave", mine) });
  });

  bot.command("status", async (ctx) => {
    const from = ctx.from;
    if (!from || ctx.chat.type !== "private") {
      const username = bot.botInfo?.username;
      await ctx.reply(
        username
          ? `Списки — в личке с ботом: открой @${username} и пришли /status`
          : "Списки — в личке с ботом: /status",
      );
      return;
    }

    const mySwaps = await deps.repo.getParticipatingSwaps(from.id);
    if (mySwaps.length === 0) {
      const open = await deps.repo.listSwaps(["collecting"], "public");
      if (open.length > 0) {
        const list = open.map((s) => `• ${s.title ?? "Без названия"}`).join("\n");
        await ctx.reply(
          `Ты пока не участвуешь ни в одном свопе.\n\nОткрытые свопы:\n${list}\n\nЧтобы участвовать — просто пришли мне песню или сдай её в чате группы.`,
        );
      } else {
        await ctx.reply("Активных свопов нет.");
      }
      return;
    }

    const lines: string[] = [];
    for (const [i, swap] of mySwaps.entries()) {
      if (i > 0) lines.push("");
      const icon = swap.mode === "secret" ? "🤫" : "🎵";
      lines.push(`${icon} Своп${swap.title ? ` «${swap.title}»` : ""} — ${stateLabel(swap.state)}`, "");
      const participants = await deps.repo.getParticipantsWithCounts(swap.id);
      lines.push(`Участники (${participants.length}):`);
      for (const p of participants) {
        lines.push(`• ${p.display_name} — ${p.song_count} ${plural(p.song_count, "песня", "песни", "песен")}`);
      }
      const mySongs = await deps.repo.getUserSongTexts(swap.id, from.id);
      if (mySongs.length > 0) {
        lines.push("", `Твои песни (${mySongs.length}):`);
        mySongs.forEach((song, n) => lines.push(`${n + 1}. ${song}`));
      }
      if (swap.mode === "public") {
        const songs = await deps.repo.getSongs(swap.id);
        if (songs.length > 0) {
          lines.push("", "Все песни:");
          for (const p of participants) {
            const own = songs.filter((s) => s.user_id === p.user_id);
            if (own.length === 0) continue;
            lines.push(`${p.display_name}:`);
            for (const s of own) lines.push(`  • ${s.text}`);
          }
        }
      }
      if (swap.state === "drawn") {
        const assignment = await deps.repo.getMyAssignment(swap.id, from.id);
        if (assignment) {
          lines.push("", `🎤 Твой жребий: «${assignment.songText}» (принёс ${assignment.providerName})`);
        }
      }
    }
    await sendLongText(ctx.api, ctx.chat.id, lines.join("\n"));
  });
}

function stateLabel(state: SwapState): string {
  switch (state) {
    case "collecting":
      return "🔓 приём песен открыт";
    case "closed":
      return "🔒 приём закрыт, ждём жеребьёвку";
    case "drawn":
      return "🎲 жеребьёвка проведена";
  }
}
