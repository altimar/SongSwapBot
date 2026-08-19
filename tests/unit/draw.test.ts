import { describe, expect, it } from "vitest";
import { computeDraw } from "../../src/logic/draw";
import type { SongRow } from "../../src/db/types";

const ITERATIONS = 200;

function mkParticipants(n: number) {
  return Array.from({ length: n }, (_, i) => ({ user_id: i + 1, display_name: `U${i + 1}` }));
}

function mkSongs(participants: { user_id: number }[]): SongRow[] {
  const songs: SongRow[] = [];
  let id = 1;
  for (const p of participants) {
    for (const k of [1, 2]) {
      songs.push({ id: id++, swap_id: 1, user_id: p.user_id, text: `S${p.user_id}-${k}`, created_at: "" });
    }
  }
  return songs;
}

function invariants(n: number) {
  for (let iter = 0; iter < ITERATIONS; iter++) {
    const participants = mkParticipants(n);
    const songs = mkSongs(participants);
    const pairs = computeDraw(participants, songs);

    // каждый поёт ровно один раз, никто не поёт свою, песня принадлежит поставщику
    expect(pairs).toHaveLength(n);
    expect(new Set(pairs.map((p) => p.singer.user_id)).size).toBe(n);
    for (const p of pairs) {
      expect(p.singer.user_id).not.toBe(p.provider.user_id);
      expect(p.song.user_id).toBe(p.provider.user_id);
    }

    const providerCounts = new Map<number, number>();
    for (const p of pairs) {
      providerCounts.set(p.provider.user_id, (providerCounts.get(p.provider.user_id) ?? 0) + 1);
    }
    const edges = new Set(pairs.map((p) => `${p.singer.user_id}->${p.provider.user_id}`));

    if (n % 2 === 0) {
      // чётное: все — поставщики ровно один раз, пары строго взаимные
      expect(providerCounts.size).toBe(n);
      expect([...providerCounts.values()].every((c) => c === 1)).toBe(true);
      for (const p of pairs) {
        expect(edges.has(`${p.provider.user_id}->${p.singer.user_id}`)).toBe(true);
      }
    } else {
      // нечётное: ровно один дважды-поставщик, ровно один «последний без пары»,
      // у всех остальных пары взаимные
      expect(providerCounts.size).toBe(n - 1);
      const counts = [...providerCounts.values()].sort((a, b) => a - b);
      expect(counts[counts.length - 1]).toBe(2);
      expect(counts.slice(0, -1).every((c) => c === 1)).toBe(true);
      const leftover = participants.find((p) => !providerCounts.has(p.user_id));
      expect(leftover).toBeDefined();
      for (const p of pairs) {
        if (p.singer.user_id === leftover!.user_id) continue;
        expect(edges.has(`${p.provider.user_id}->${p.singer.user_id}`)).toBe(true);
      }
    }
  }
}

describe("computeDraw — свопы взаимными парами", () => {
  it("меньше 2 участников — ошибка", () => {
    expect(() => computeDraw(mkParticipants(1), mkSongs(mkParticipants(1)))).toThrow();
    expect(() => computeDraw([], [])).toThrow();
  });

  it("участник без песен — ошибка", () => {
    const participants = mkParticipants(2);
    const songs = mkSongs([participants[0]]);
    expect(() => computeDraw(participants, songs)).toThrow(/нет ни одной песни/);
  });

  for (const n of [2, 3, 4, 5, 6, 7, 8, 9]) {
    it(`инварианты при n=${n} (${ITERATIONS} итераций)`, () => invariants(n));
  }
});
