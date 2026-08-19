export type SwapMode = "public" | "secret";
export type SwapState = "collecting" | "closed" | "drawn";

export interface SwapRow {
  id: number;
  mode: SwapMode;
  chat_id: number;
  title: string | null;
  state: SwapState;
  created_at: string;
}

export interface ParticipantRow {
  swap_id: number;
  user_id: number;
  display_name: string;
  username: string | null;
  joined_at: string;
}

export interface ParticipantWithCount extends ParticipantRow {
  song_count: number;
}

export interface SongRow {
  id: number;
  swap_id: number;
  user_id: number;
  text: string;
  created_at: string;
}
