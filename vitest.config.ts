import { defineConfig } from "vitest/config";

// Юнит-тесты гоняются в обычном Node (чистая логика без биндингов воркера).
// E2E живёт отдельно: tests/e2e/run.mjs поднимает wrangler dev + мок Telegram API.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
});
