import type { Api, Context } from "grammy";
import type { SwapRow } from "../db/types";
import type { BotDeps } from "../deps";
import { plural } from "../logic/notify";

const MAX_SONGS_PER_MESSAGE = 50;

// Участник ли чата (для публичных свопов, привязанных к группе). Ошибка API
// (бот удалён из чата и т.п.) трактуется как «не участник» — не пускаем.
export async function isChatMember(api: Api, chatId: number, userId: number): Promise<boolean> {
  try {
    const member = await api.getChatMember(chatId, userId);
    if (member.status === "member" || member.status === "administrator" || member.status === "creator") {
      return true;
    }
    return member.status === "restricted" && member.is_member;
  } catch (error) {
    console.error(`getChatMember(${chatId}, ${userId}) failed:`, error);
    return false;
  }
}

async function chatTitle(api: Api, chatId: number): Promise<string | null> {
  try {
    const chat = await api.getChat(chatId);
    return chat.title ?? null;
  } catch {
    return null;
  }
}

// Клавиатура выбора свопа: pick:<action>:<swapId>
export function chooserKeyboard(action: string, swaps: SwapRow[]) {
  return {
    inline_keyboard: swaps.map((swap) => [
      {
        text: `${swap.mode === "secret" ? "🤫" : "🎵"} ${swap.title ?? "Без названия"}`,
        callback_data: `pick:${action}:${swap.id}`,
      },
    ]),
  };
}

export function rerunKeyboard(swapId: number) {
  return {
    inline_keyboard: [
      [
        { text: "🎲 Переразыграть", callback_data: `draw:${swapId}:rerun` },
        { text: "Отмена", callback_data: "admin:cancel" },
      ],
    ],
  };
}

export function displayName(user: { first_name: string; last_name?: string }): string {
  return user.last_name ? `${user.first_name} ${user.last_name}` : user.first_name;
}

// Ядро приёма песен в конкретный своп: гварды состояния и участия в чате,
// дедуп, запись, ответ.
export async function addSongsToSwap(ctx: Context, deps: BotDeps, swap: SwapRow, raw: string): Promise<void> {
  const from = ctx.from;
  if (!from) return;
  if (swap.state !== "collecting") {
    await ctx.reply("Приём песен уже закрыт 🔒");
    return;
  }

  // Любой своп привязан к чату, где стартовал: попасть могут только его участники.
  // Заявки из самой группы не проверяем: кто пишет в чат — тот и участник.
  if (ctx.chat?.type === "private") {
    if (!(await isChatMember(ctx.api, swap.chat_id, from.id))) {
      const title = await chatTitle(ctx.api, swap.chat_id);
      await ctx.reply(
        `Этот своп только для участников чата${title ? ` «${title}»` : ""} — сначала вступи туда. Сдать песню можно и прямо в чате.`,
      );
      return;
    }
  }

  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return;

  const existingTexts = await deps.repo.getUserSongTexts(swap.id, from.id);
  const seen = new Set(existingTexts.map((t) => t.toLowerCase()));
  const fresh: string[] = [];
  let skippedDuplicates = 0;
  for (const line of lines) {
    const key = line.toLowerCase();
    if (seen.has(key)) {
      skippedDuplicates++;
      continue;
    }
    seen.add(key);
    fresh.push(line);
  }
  if (fresh.length === 0) {
    await ctx.reply("Такие песни уже есть в твоём списке 🙂");
    return;
  }

  const truncated = fresh.length > MAX_SONGS_PER_MESSAGE;
  const accepted = fresh.slice(0, MAX_SONGS_PER_MESSAGE);
  await deps.repo.addSongs(
    swap.id,
    { userId: from.id, displayName: displayName(from), username: from.username ?? null },
    accepted,
  );

  const total = (await deps.repo.getUserSongTexts(swap.id, from.id)).length;
  const parts = [
    `Принял ${accepted.length} ${plural(accepted.length, "песню", "песни", "песен")}:`,
    ...accepted.map((line) => `• ${line}`),
  ];
  if (truncated) {
    parts.push(`(за один раз беру не больше ${MAX_SONGS_PER_MESSAGE} — пришли остальные ещё сообщением)`);
  }
  if (skippedDuplicates > 0) {
    parts.push(`${skippedDuplicates} ${plural(skippedDuplicates, "дубликат", "дубликата", "дубликатов")} пропустил`);
  }
  parts.push(`Всего твоих песен: ${total}. Ждём жеребьёвку 🎤`);
  await ctx.reply(parts.join("\n"));
}
