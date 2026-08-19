import type { Api } from "grammy";

const MESSAGE_LIMIT = 4000;

// Отправка, которая не роняет обработку: юзер мог не открыть личку с ботом
// (403) или отписаться — такие сбои возвращаем, а не бросаем.
export async function sendSafe(api: Api, chatId: number, text: string): Promise<boolean> {
  try {
    await api.sendMessage(chatId, text);
    return true;
  } catch (error) {
    console.error(`sendMessage to ${chatId} failed:`, error);
    return false;
  }
}

// Telegram режет сообщения на 4096 символов — режем сами по границам строк.
export async function sendLongText(api: Api, chatId: number, text: string): Promise<void> {
  let rest = text.trim();
  while (rest.length > 0) {
    let cut = rest.length;
    if (cut > MESSAGE_LIMIT) {
      const newline = rest.lastIndexOf("\n", MESSAGE_LIMIT);
      cut = newline > MESSAGE_LIMIT / 2 ? newline : MESSAGE_LIMIT;
    }
    await sendSafe(api, chatId, rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
}

// 1 песня / 2 песни / 5 песен
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
