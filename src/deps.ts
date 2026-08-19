import type { Repo } from "./db/repo";

export interface BotDeps {
  repo: Repo;
  adminIds: Set<number>;
}
