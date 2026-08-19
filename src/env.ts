export interface Env {
  BOT_TOKEN: string;
  WEBHOOK_SECRET: string;
  /** Опционально: суперадмины со правами на все свопы. По умолчанию не задан —
   *  права раздают администраторы чатов (см. handlers/shared.ts, canAdminChat). */
  ADMIN_IDS?: string;
  DB: D1Database;
  /** Опционально: подставной getMe для локальной разработки (пропускает вызов Telegram API при init). */
  BOT_INFO_JSON?: string;
  /** Опционально: свой корень Bot API (например, локальный мок или self-hosted Bot API server). */
  TELEGRAM_API_ROOT?: string;
}
