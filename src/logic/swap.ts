import type { Api } from "grammy";
import type { Repo } from "../db/repo";
import type { SwapRow } from "../db/types";
import { computeDraw, type DrawPair } from "./draw";
import { sendSafe } from "./notify";

export interface DrawSuccess {
  ok: true;
  participants: number;
  failedDelivery: string[];
  publicTableSent: boolean;
}

export interface DrawFailure {
  ok: false;
  error: string;
}

export type DrawResult = DrawSuccess | DrawFailure;

// Сначала атомарно пишем назначения в БД, только потом рассылаем:
// упавшая отправка не должна оставлять своп в состоянии «колотый напополам».
export async function runDraw(api: Api, repo: Repo, swap: SwapRow): Promise<DrawResult> {
  const participants = await repo.getParticipantsWithCounts(swap.id);
  if (participants.length < 2) {
    return { ok: false, error: "нужно минимум 2 участника с песнями" };
  }
  const songs = await repo.getSongs(swap.id);
  let pairs: DrawPair[];
  try {
    pairs = computeDraw(participants, songs);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  await repo.saveDraw(
    swap.id,
    pairs.map((p) => ({
      singerId: p.singer.user_id,
      providerId: p.provider.user_id,
      songId: p.song.id,
    })),
  );

  const failedDelivery: string[] = [];
  for (const pair of pairs) {
    const delivered = await sendSafe(
      api,
      pair.singer.user_id,
      `🎤 Ты поёшь: «${pair.song.text}»\nПесню принёс: ${pair.provider.display_name}`,
    );
    if (!delivered) failedDelivery.push(pair.singer.display_name);
  }

  let publicTableSent = false;
  if (swap.mode === "public") {
    const titlePart = swap.title ? ` «${swap.title}»` : "";
    const rows = pairs.map(
      (p) => `• ${p.singer.display_name} → «${p.song.text}» (${p.provider.display_name})`,
    );
    publicTableSent = await sendSafe(
      api,
      swap.chat_id,
      `🎲 Жеребьёвка${titlePart} проведена!\n\n${rows.join("\n")}`,
    );
  } else {
    // Секретный своп: в чат — только нейтральная строка, пары не раскрываем.
    const titlePart = swap.title ? ` «${swap.title}»` : "";
    await sendSafe(
      api,
      swap.chat_id,
      `🎲 Жеребьёвка секретного свопа${titlePart} проведена — каждый участник получил свою песню в личку.`,
    );
  }

  return { ok: true, participants: participants.length, failedDelivery, publicTableSent };
}

export function drawSummaryText(result: DrawSuccess): string {
  const lines = [`🎲 Жеребьёвка проведена! Участников: ${result.participants}.`];
  if (result.publicTableSent) lines.push("Полная таблица — в чате свопа.");
  lines.push("Каждому участнику отправил его песню в личку.");
  if (result.failedDelivery.length > 0) {
    lines.push(`⚠️ Не доставлено (пусть напишут боту /start): ${result.failedDelivery.join(", ")}`);
  }
  return lines.join("\n");
}

// Закрытие приёма: переводит состояние и рассылает анонсы (в чат свопа или участникам
// секретного свопа). Возвращает текст для ответа админу.
export async function closeSwap(
  api: Api,
  repo: Repo,
  swap: SwapRow,
  origin: { actorId: number; chatId: number },
): Promise<string> {
  if (swap.state !== "collecting") {
    return "Приём и так уже закрыт 🔒";
  }
  await repo.setState(swap.id, "closed");
  const stats = await repo.getSwapStats(swap.id);
  const summary = `🔒 Приём песен закрыт. Участников: ${stats.participants}, песен: ${stats.songs}.`;
  if (swap.mode === "public" && origin.chatId !== swap.chat_id) {
    // Команда пришла не из чата свопа — анонсируем в чат отдельно; иначе реплая хватит.
    // В чат свопа админ-команды не светим.
    await sendSafe(api, swap.chat_id, `${summary} Жеребьёвка скоро 🎤`);
  } else if (swap.mode === "secret") {
    const titlePart = swap.title ? ` «${swap.title}»` : "";
    if (origin.chatId !== swap.chat_id) {
      await sendSafe(api, swap.chat_id, `🔒 Приём песен в секретном свопе${titlePart} закрыт.`);
    }
    for (const p of await repo.getParticipantsWithCounts(swap.id)) {
      if (p.user_id === origin.actorId) continue;
      await sendSafe(api, p.user_id, `${summary}\nЖеребьёвка скоро — следи за личкой 🎲`);
    }
  }
  return `${summary} Жеребьёвка скоро 🎤`;
}
