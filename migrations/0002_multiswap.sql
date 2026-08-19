-- Поддержка параллельных свопов: один активный своп на чат.
CREATE UNIQUE INDEX idx_swaps_chat ON swaps(chat_id);

-- Песни из лички, ожидающие выбора свопа кнопкой (одна незавершённая попытка на юзера).
CREATE TABLE pending_intake (
  user_id    INTEGER PRIMARY KEY,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
