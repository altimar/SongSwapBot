import type { ParticipantWithCount, SongRow, SwapMode, SwapRow, SwapState } from "./types";

const BATCH_CHUNK = 100;

export class Repo {
  constructor(private readonly db: D1Database) {}

  getSwapById(swapId: number): Promise<SwapRow | null> {
    return this.db.prepare("SELECT * FROM swaps WHERE id = ?").bind(swapId).first<SwapRow>();
  }

  getSwapByChat(chatId: number): Promise<SwapRow | null> {
    return this.db.prepare("SELECT * FROM swaps WHERE chat_id = ?").bind(chatId).first<SwapRow>();
  }

  async listSwaps(states: SwapState[], mode?: SwapMode): Promise<SwapRow[]> {
    const params: (string | number)[] = [...states];
    const conditions = [`state IN (${states.map(() => "?").join(", ")})`];
    if (mode) {
      conditions.push("mode = ?");
      params.push(mode);
    }
    const { results } = await this.db
      .prepare(`SELECT * FROM swaps WHERE ${conditions.join(" AND ")} ORDER BY id`)
      .bind(...params)
      .all<SwapRow>();
    return results;
  }

  async getParticipatingSwaps(userId: number, state?: SwapState): Promise<SwapRow[]> {
    const stateCond = state ? " AND sw.state = ?" : "";
    const { results } = await this.db
      .prepare(
        `SELECT sw.* FROM swaps sw
         JOIN participants p ON p.swap_id = sw.id AND p.user_id = ?${stateCond}
         ORDER BY sw.id`,
      )
      .bind(...(state ? [userId, state] : [userId]))
      .all<SwapRow>();
    return results;
  }

  // Инвариант: один активный своп на чат — /newswap заменяет только своп этого чата,
  // каскадно стирая его участников, песни и назначения.
  async createSwap(mode: SwapMode, chatId: number, title: string | null): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM swaps WHERE chat_id = ?").bind(chatId),
      this.db
        .prepare("INSERT INTO swaps (mode, chat_id, title, state) VALUES (?, ?, ?, 'collecting')")
        .bind(mode, chatId, title),
    ]);
  }

  async savePendingIntake(userId: number, text: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO pending_intake (user_id, text) VALUES (?, ?)
         ON CONFLICT (user_id) DO UPDATE SET text = excluded.text, created_at = datetime('now')`,
      )
      .bind(userId, text)
      .run();
  }

  async takePendingIntake(userId: number): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT text FROM pending_intake WHERE user_id = ?")
      .bind(userId)
      .first<{ text: string }>();
    if (!row) return null;
    await this.db.prepare("DELETE FROM pending_intake WHERE user_id = ?").bind(userId).run();
    return row.text;
  }

  async setState(swapId: number, state: SwapState): Promise<void> {
    await this.db
      .prepare("UPDATE swaps SET state = ? WHERE id = ?")
      .bind(state, swapId)
      .run();
  }

  async getParticipantsWithCounts(swapId: number): Promise<ParticipantWithCount[]> {
    const { results } = await this.db
      .prepare(
        `SELECT p.user_id, p.display_name, p.username, p.joined_at,
                COUNT(s.id) AS song_count
         FROM participants p
         LEFT JOIN songs s ON s.swap_id = p.swap_id AND s.user_id = p.user_id
         WHERE p.swap_id = ?
         GROUP BY p.user_id
         ORDER BY p.joined_at, p.user_id`,
      )
      .bind(swapId)
      .all<ParticipantWithCount>();
    return results;
  }

  async isParticipant(swapId: number, userId: number): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT 1 FROM participants WHERE swap_id = ? AND user_id = ?")
      .bind(swapId, userId)
      .first();
    return row !== null;
  }

  async removeParticipant(swapId: number, userId: number): Promise<void> {
    await this.db.batch([
      this.db
        .prepare("DELETE FROM songs WHERE swap_id = ? AND user_id = ?")
        .bind(swapId, userId),
      this.db
        .prepare("DELETE FROM participants WHERE swap_id = ? AND user_id = ?")
        .bind(swapId, userId),
    ]);
  }

  async getUserSongTexts(swapId: number, userId: number): Promise<string[]> {
    const { results } = await this.db
      .prepare("SELECT text FROM songs WHERE swap_id = ? AND user_id = ? ORDER BY id")
      .bind(swapId, userId)
      .all<{ text: string }>();
    return results.map((r) => r.text);
  }

  async getSongs(swapId: number): Promise<SongRow[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM songs WHERE swap_id = ? ORDER BY user_id, id")
      .bind(swapId)
      .all<SongRow>();
    return results;
  }

  // Первая песня делает участником; при повторных добавках обновляем имя/юзернейм.
  async addSongs(
    swapId: number,
    user: { userId: number; displayName: string; username: string | null },
    texts: string[],
  ): Promise<void> {
    if (texts.length === 0) return;
    const statements = [
      this.db
        .prepare(
          `INSERT INTO participants (swap_id, user_id, display_name, username)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (swap_id, user_id) DO UPDATE SET
             display_name = excluded.display_name,
             username = excluded.username`,
        )
        .bind(swapId, user.userId, user.displayName, user.username),
      ...texts.map((text) =>
        this.db
          .prepare("INSERT INTO songs (swap_id, user_id, text) VALUES (?, ?, ?)")
          .bind(swapId, user.userId, text),
      ),
    ];
    for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
      await this.db.batch(statements.slice(i, i + BATCH_CHUNK));
    }
  }

  async getSwapStats(swapId: number): Promise<{ participants: number; songs: number }> {
    const row = await this.db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM participants WHERE swap_id = ?1) AS participants,
           (SELECT COUNT(*) FROM songs WHERE swap_id = ?1) AS songs`,
      )
      .bind(swapId)
      .first<{ participants: number; songs: number }>();
    return row ?? { participants: 0, songs: 0 };
  }

  // Атомарно: затирает прошлые назначения, пишет новые и переводит своп в drawn.
  async saveDraw(
    swapId: number,
    pairs: { singerId: number; providerId: number; songId: number }[],
  ): Promise<void> {
    await this.db.batch([
      this.db.prepare("DELETE FROM assignments WHERE swap_id = ?").bind(swapId),
      ...pairs.map((p) =>
        this.db
          .prepare(
            `INSERT INTO assignments (swap_id, singer_user_id, provider_user_id, song_id)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(swapId, p.singerId, p.providerId, p.songId),
      ),
      this.db.prepare("UPDATE swaps SET state = 'drawn' WHERE id = ?").bind(swapId),
    ]);
  }

  async getMyAssignment(
    swapId: number,
    userId: number,
  ): Promise<{ songText: string; providerName: string } | null> {
    return this.db
      .prepare(
        `SELECT s.text AS songText, pp.display_name AS providerName
         FROM assignments a
         JOIN songs s ON s.id = a.song_id
         JOIN participants pp ON pp.swap_id = a.swap_id AND pp.user_id = a.provider_user_id
         WHERE a.swap_id = ? AND a.singer_user_id = ?`,
      )
      .bind(swapId, userId)
      .first<{ songText: string; providerName: string }>();
  }
}
