CREATE TABLE swaps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  mode       TEXT    NOT NULL CHECK (mode IN ('public', 'secret')),
  chat_id    INTEGER NOT NULL,
  title      TEXT,
  state      TEXT    NOT NULL DEFAULT 'collecting'
                     CHECK (state IN ('collecting', 'closed', 'drawn')),
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE participants (
  swap_id      INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL,
  display_name TEXT    NOT NULL,
  username     TEXT,
  joined_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (swap_id, user_id)
);

CREATE TABLE songs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  swap_id    INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL,
  text       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_songs_swap_user ON songs(swap_id, user_id);

CREATE TABLE assignments (
  swap_id          INTEGER NOT NULL REFERENCES swaps(id) ON DELETE CASCADE,
  singer_user_id   INTEGER NOT NULL,
  provider_user_id INTEGER NOT NULL,
  song_id          INTEGER NOT NULL REFERENCES songs(id),
  UNIQUE (swap_id, singer_user_id)
);
