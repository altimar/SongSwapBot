import type { SongRow } from "../db/types";

export interface DrawParticipant {
  user_id: number;
  display_name: string;
}

export interface DrawPair {
  singer: DrawParticipant;
  provider: DrawParticipant;
  song: SongRow;
}

// Жеребьёвка «свопами»: участники режутся на взаимные пары и меняются песнями.
// При нечётном числе последний без пары поёт случайную песню случайно выбранного
// участника — это единственный случай, когда песни одного человека достаются двоим.
export function computeDraw(participants: DrawParticipant[], songs: SongRow[]): DrawPair[] {
  if (participants.length < 2) {
    throw new Error("Для жеребьёвки нужно минимум 2 участника.");
  }
  const songsByUser = new Map<number, SongRow[]>();
  for (const song of songs) {
    const list = songsByUser.get(song.user_id);
    if (list) list.push(song);
    else songsByUser.set(song.user_id, [song]);
  }
  for (const participant of participants) {
    if (!songsByUser.has(participant.user_id)) {
      throw new Error(`У «${participant.display_name}» нет ни одной песни.`);
    }
  }

  const pickSong = (provider: DrawParticipant): SongRow => {
    const list = songsByUser.get(provider.user_id)!;
    return list[randomInt(list.length)];
  };
  const swapPair = (a: DrawParticipant, b: DrawParticipant): DrawPair[] => [
    { singer: a, provider: b, song: pickSong(b) },
    { singer: b, provider: a, song: pickSong(a) },
  ];

  const order = shuffled(participants);
  const pairs: DrawPair[] = [];
  let i = 0;
  while (i + 1 < order.length) {
    pairs.push(...swapPair(order[i], order[i + 1]));
    i += 2;
  }
  if (i < order.length) {
    const leftover = order[i];
    const others = order.filter((p) => p.user_id !== leftover.user_id);
    const provider = others[randomInt(others.length)];
    pairs.push({ singer: leftover, provider, song: pickSong(provider) });
  }
  return pairs;
}

function shuffled<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// crypto.getRandomValues + rejection sampling, без modulo bias.
function randomInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error("maxExclusive must be positive");
  const limit = Math.floor(2 ** 32 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value >= limit);
  return value % maxExclusive;
}
