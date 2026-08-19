#!/usr/bin/env node
// E2E-раннер: поднимает мок Telegram Bot API и wrangler dev с локальной D1,
// прогоняет все сценарии фейковыми апдейтами и сверяет базу и исходящие сообщения.
// Запуск: npm run test:e2e (порты 8787/8788 должны быть свободны).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = Number(process.env.E2E_PORT ?? 8787);
const MOCK_PORT = Number(process.env.E2E_MOCK_PORT ?? 8788);
const SECRET = "test-secret";
const ADMIN = 111;
const BOT_USERNAME = "test_bot";
const BOT_INFO = { id: 999, is_bot: true, first_name: "T", username: BOT_USERNAME };

const outbox = [];
let uid = 0;
const checks = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- мок Telegram API ----------

function buttonsOf(replyMarkup) {
  if (!replyMarkup || !Array.isArray(replyMarkup.inline_keyboard)) return [];
  return replyMarkup.inline_keyboard.flat().map((b) => b.callback_data);
}

function startMock() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed = {};
        try {
          parsed = JSON.parse(body);
        } catch {}
        const method = req.url.split("/").pop();
        outbox.push({ method, chat: String(parsed.chat_id ?? ""), text: parsed.text ?? "", buttons: buttonsOf(parsed.reply_markup) });

        // Правило для тестов: user_id >= 9000 — не участник чата, остальные — member.
        let result = { message_id: 1, date: 0, chat: { id: 1, type: "private" }, text: "" };
        if (method === "getChatMember") {
          const status = Number(parsed.user_id) >= 9000 ? "left" : "member";
          result = { status, user: { id: parsed.user_id, is_bot: false, first_name: "U" } };
        } else if (method === "getChat") {
          result = { id: parsed.chat_id, type: "supergroup", title: "Мок-чат" };
        }
        const payload = JSON.stringify({ ok: true, result });
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        });
        res.end(payload);
      });
    });
    server.listen(MOCK_PORT, "127.0.0.1", () => resolve(server));
  });
}

// ---------- конструкторы апдейтов ----------

const group = (id, title = "G") => ({ id, type: "supergroup", title });
const priv = (id) => ({ id, type: "private", first_name: "U" + id });

const WRANGLER_LOG_PATH = path.join(os.tmpdir(), "songswap-e2e-wrangler.log");
let wr = null;
let wranglerLogFd = null;

function startWrangler() {
  fs.writeFileSync(WRANGLER_LOG_PATH, `\n=== e2e ${new Date().toISOString()} ===\n`, { flag: "a" });
  wranglerLogFd = fs.openSync(WRANGLER_LOG_PATH, "a");
  wr = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", String(PORT),
      "--var", `TELEGRAM_API_ROOT:http://127.0.0.1:${MOCK_PORT}`,
      "--var", "BOT_TOKEN:1:TEST",
      "--var", `WEBHOOK_SECRET:${SECRET}`,
      "--var", `ADMIN_IDS:${ADMIN}`,
      "--var", `BOT_INFO_JSON:${JSON.stringify(BOT_INFO)}`,
    ],
    {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", wranglerLogFd, wranglerLogFd],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    },
  );
}

function stopWrangler() {
  if (wr) {
    try {
      process.kill(-wr.pid, "SIGKILL");
    } catch {}
    wr = null;
  }
  if (wranglerLogFd !== null) {
    try {
      fs.closeSync(wranglerLogFd);
    } catch {}
    wranglerLogFd = null;
  }
}

async function postUpdate(update) {
  const res = await fetch(`http://127.0.0.1:${PORT}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": SECRET },
    body: JSON.stringify(update),
  });
  return res.status;
}

// Workerd изредка молча падает в dev-режиме. Все мутирующие операции бота атомарны
// (один batch), а состояние живёт в локальной D1 — поэтому перезапуск воркера
// и повтор апдейта безопасен.
async function send(update) {
  try {
    return await postUpdate(update);
  } catch (e) {
    console.log("  … воркер недоступен, перезапускаю стенд и повторяю апдейт");
    stopWrangler();
    for (let i = 0; i < 30 && (await portBusy(PORT)); i++) await sleep(500);
    startWrangler();
    if (!(await waitReady())) throw new Error("воркер не поднялся после перезапуска");
    return postUpdate(update);
  }
}

function baseMsg(user, chat, extra) {
  uid++;
  return {
    update_id: uid,
    message: {
      message_id: uid,
      from: { id: user, is_bot: false, first_name: "U" + user },
      chat,
      date: 1700000000 + uid,
      ...extra,
    },
  };
}

function msg(user, chat, text) {
  const entities = text.startsWith("/")
    ? [{ offset: 0, length: text.split(" ")[0].length, type: "bot_command" }]
    : undefined;
  return baseMsg(user, chat, { text, ...(entities ? { entities } : {}) });
}

function mentionMsg(user, chat, payload) {
  return baseMsg(user, chat, {
    text: `@${BOT_USERNAME} ${payload}`,
    entities: [{ offset: 0, length: 1 + BOT_USERNAME.length, type: "mention" }],
  });
}

function photoMsg(user, chat) {
  return baseMsg(user, chat, { photo: [{ file_id: "x" }] });
}

function cb(user, chat, data) {
  uid++;
  return {
    update_id: uid,
    callback_query: {
      id: "c" + uid,
      from: { id: user, is_bot: false, first_name: "U" + user },
      message: {
        message_id: uid,
        from: { id: 999, is_bot: true, first_name: "T" },
        chat,
        date: 1700000000 + uid,
        text: "c",
      },
      data,
    },
  };
}

// ---------- утилиты проверок ----------

function db(command) {
  const r = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "songswap", "--local", "--json", "--command", command],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error("d1 execute failed: " + r.stderr);
  return JSON.parse(r.stdout)[0].results;
}

function check(name, cond, extra) {
  checks.push([name, !!cond]);
  console.log((cond ? "OK  " : "FAIL") + " " + name + (cond || extra === undefined ? "" : " :: " + JSON.stringify(extra)));
}

const sentTo = (chat) => outbox.filter((o) => o.chat === String(chat));
const allButtons = (prefix) => outbox.flatMap((o) => o.buttons.filter((b) => b.startsWith(prefix)));

async function resetDb() {
  db("DELETE FROM swaps");
  db("DELETE FROM pending_intake");
  outbox.length = 0;
}

function checkDrawInvariants(swapId, participants, odd) {
  const rows = db(
    `SELECT a.singer_user_id AS s, a.provider_user_id AS p, so.user_id AS owner
     FROM assignments a JOIN songs so ON so.id = a.song_id WHERE a.swap_id = ${swapId}`,
  );
  check(`жеребьёвка: поют все ${participants.length} ровно один раз`,
    rows.length === participants.length && new Set(rows.map((r) => r.s)).size === participants.length, rows);
  check("жеребьёвка: никто не поёт свою и песня принадлежит поставщику",
    rows.every((r) => r.s !== r.p && r.owner === r.p));
  const counts = new Map();
  rows.forEach((r) => counts.set(r.p, (counts.get(r.p) ?? 0) + 1));
  const edges = new Set(rows.map((r) => `${r.s}->${r.p}`));
  if (!odd) {
    check("жеребьёвка (чётное): каждый поставщик ровно один раз, пары взаимные",
      counts.size === participants.length && [...counts.values()].every((c) => c === 1) &&
        rows.every((r) => edges.has(`${r.p}->${r.s}`)), [...counts.entries()]);
  } else {
    const sorted = [...counts.values()].sort((a, b) => a - b);
    const leftover = participants.find((p) => !counts.has(p));
    check("жеребьёвка (нечётное): один дважды-поставщик, один без пары, остальные взаимны",
      counts.size === participants.length - 1 && sorted[sorted.length - 1] === 2 &&
        sorted.slice(0, -1).every((c) => c === 1) && leftover !== undefined &&
        rows.filter((r) => r.s !== leftover).every((r) => edges.has(`${r.p}->${r.s}`)),
      { counts: [...counts.entries()], leftover });
  }
}

// ---------- сценарии ----------

async function scenarioSinglePublic() {
  console.log("\n=== Сценарий 1: полный цикл публичного свопа ===");
  const g = group(-3001, "Караоке");
  await send(msg(ADMIN, g, "/newswap Тестовый"));
  let swaps = db("SELECT id, mode, chat_id, title, state FROM swaps");
  check("своп создан сразу (без подтверждения), публичный, collecting",
    swaps.length === 1 && swaps[0].mode === "public" && swaps[0].state === "collecting" && swaps[0].title === "Тестовый", swaps);
  const S = swaps[0].id;
  check("приветствие с названием и инструкцией",
    sentTo(-3001).some((o) => o.text.includes("Своп «Тестовый» открыт") && o.text.includes("/add")));

  await send(msg(10, g, "/add Король и Шут — Лесник\nКукла колдуна"));
  await send(mentionMsg(11, g, "Ария — Беспечный ангел"));
  await send(msg(12, priv(12), "Сплин — Выхода нет\nЗемфира — Рома"));
  check("песни легли от всех троих (команда, упоминание, личка)",
    db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S}`)[0].n === 5 &&
      db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S}`)[0].n === 3);

  await send(msg(10, g, "/add Кукла колдуна"));
  check("дубликат отклонён", db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S}`)[0].n === 5 &&
    sentTo(-3001).some((o) => o.text.includes("уже есть")));

  await send(msg(12, priv(12), "/leave"));
  check("/leave удаляет участника с песнями",
    db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S} AND user_id=12`)[0].n === 0 &&
      db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S} AND user_id=12`)[0].n === 0);
  await send(msg(12, priv(12), "Сплин — Выхода нет"));
  check("повторное вступление работает",
    db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S} AND user_id=12`)[0].n === 1);

  await send(msg(9001, priv(9001), "Чужая песня"));
  check("чужак (не из чата) не вступает в своп через личку",
    db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S} AND user_id=9001`)[0].n === 0 &&
      sentTo(9001).some((o) => o.text.includes("только для участников")));

  await send(msg(10, g, "/close"));
  check("не-админу команды закрыты", sentTo(-3001).some((o) => o.text.includes("только для админов")));

  await send(msg(ADMIN, g, "/close"));
  check("приём закрыт", db(`SELECT state FROM swaps WHERE id=${S}`)[0].state === "closed");
  const announceCount = sentTo(-3001).filter((o) => o.text.startsWith("🔒 Приём песен закрыт")).length;
  check("анонс закрытия — ровно один (без дубля)", announceCount === 1, announceCount);
  await send(msg(10, g, "/add Ещё песня"));
  check("после close заявки отклоняются", db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S}`)[0].n === 4 &&
    sentTo(-3001).some((o) => o.text.includes("Приём песен уже закрыт")));

  await send(msg(ADMIN, g, "/draw"));
  check("статус drawn", db(`SELECT state FROM swaps WHERE id=${S}`)[0].state === "drawn");
  checkDrawInvariants(S, [10, 11, 12], true);
  check("каждому лично его песня", [10, 11, 12].every((u) => sentTo(u).some((o) => o.text.includes("Ты поёшь"))));
  check("таблица в группу", sentTo(-3001).some((o) => o.text.includes("Жеребьёвка «Тестовый» проведена")));
  await send(msg(10, priv(10), "/status"));
  check("статус показывает жребий", sentTo(10).some((o) => o.text.includes("Твой жребий")));

  await send(msg(ADMIN, g, "/draw"));
  check("повторный draw предлагает перерозыгрыш", allButtons(`draw:${S}:rerun`).length === 1);
  await send(cb(ADMIN, g, `draw:${S}:rerun`));
  checkDrawInvariants(S, [10, 11, 12], true);

  await send(msg(ADMIN, g, "/newswap Перезапуск"));
  check("newswap поверх живого свопа просит подтверждение", allButtons("newswap:public:").length === 1);
  await send(cb(ADMIN, g, "newswap:public:Перезапуск"));
  swaps = db("SELECT id, title, state FROM swaps");
  const S2 = swaps[0].id;
  check("своп пересоздан с очисткой данных",
    S2 !== S && swaps.length === 1 &&
      db(`SELECT COUNT(*) AS n FROM participants`)[0].n === 0 &&
      db(`SELECT COUNT(*) AS n FROM songs`)[0].n === 0 &&
      db(`SELECT COUNT(*) AS n FROM assignments`)[0].n === 0);

  await send(msg(ADMIN, g, "/close"));
  await send(msg(ADMIN, g, "/draw"));
  check("draw без участников честно отказывает",
    sentTo(-3001).some((o) => o.text.includes("минимум 2 участника")));
}

async function scenarioSecret() {
  console.log("\n=== Сценарий 2: секретный режим (якорь — группа) ===");
  const g = group(-4200, "Секретная группа");
  await send(msg(ADMIN, priv(ADMIN), "/newsecret Из лички"));
  await send(msg(ADMIN, priv(ADMIN), "/newswap Из лички"));
  check("создание из лички отклоняется с подсказкой про группу",
    sentTo(ADMIN).filter((o) => o.text.includes("Свопы создаются в групповом чате")).length === 2);
  await send(msg(77, g, "/newsecret Хак"));
  check("не-админ не может открыть секретный своп", sentTo(-4200).some((o) => o.text.includes("только для админов")));

  await send(msg(ADMIN, g, "/newsecret Тайный"));
  const swaps = db("SELECT id, mode, chat_id, state FROM swaps");
  check("секретный своп создан в группе и привязан к ней",
    swaps.length === 1 && swaps[0].mode === "secret" && swaps[0].chat_id === -4200 && swaps[0].state === "collecting", swaps);
  const S = swaps[0].id;
  check("приветствие секретного режима в группе", sentTo(-4200).some((o) => o.text.includes("Секретный своп «Тайный»")));

  await send(msg(9001, priv(9001), "Песня чужака"));
  check("чужак не попадает и в секретный своп",
    db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S} AND user_id=9001`)[0].n === 0 &&
      sentTo(9001).some((o) => o.text.includes("только для участников")));

  await send(msg(20, priv(20), "Пикник — Иероглиф"));
  await send(msg(21, priv(21), "Наутилус — Скованные одной цепью"));
  check("заявки в личке приняты", db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S}`)[0].n === 2);

  await send(msg(20, g, "/add Песня в группе"));
  check("заявка в группе секретного свопа переадресуется в личку",
    db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S}`)[0].n === 2 &&
      sentTo(-4200).some((o) => o.text.includes("только в личке")));

  await send(msg(20, priv(20), "/status"));
  const st = sentTo(20).find((o) => o.text.includes("Своп"));
  check("статус без чужих песен", st !== undefined && !st.text.includes("Все песни") && st.text.includes("Иероглиф"));

  await send(msg(ADMIN, g, "/close"));
  check("закрытие: лично участникам, состав зафиксирован",
    sentTo(20).some((o) => o.text.includes("Приём песен закрыт")) &&
      sentTo(21).some((o) => o.text.includes("Приём песен закрыт")) &&
      db(`SELECT state FROM swaps WHERE id=${S}`)[0].state === "closed");

  await send(msg(ADMIN, g, "/draw"));
  check("жеребьёвка: личные сообщения + нейтральная строка в группу, без таблицы",
    sentTo(20).some((o) => o.text.includes("Ты поёшь")) &&
      sentTo(21).some((o) => o.text.includes("Ты поёшь")) &&
      sentTo(-4200).some((o) => o.text.includes("секретного свопа «Тайный» проведена")) &&
      !outbox.some((o) => o.text.includes("→ «")));
  checkDrawInvariants(S, [20, 21], false);
}

async function scenarioMultiChat() {
  console.log("\n=== Сценарий 3: параллельные свопы в двух группах ===");
  const g1 = group(-1001, "Группа 1");
  const g2 = group(-1002, "Группа 2");
  await send(msg(ADMIN, g1, "/newswap Первый"));
  await send(msg(ADMIN, g2, "/newswap Второй"));
  let swaps = db("SELECT id, chat_id, title, state FROM swaps ORDER BY id");
  const S1 = swaps.find((s) => s.chat_id === -1001).id;
  const S2 = swaps.find((s) => s.chat_id === -1002).id;
  check("два свопа параллельно", swaps.length === 2 && swaps.every((s) => s.state === "collecting"), swaps);
  check("второй — сразу, без подтверждения", allButtons("newswap:").length === 0);

  await send(msg(10, g1, "/add Песня А1"));
  await send(msg(11, g1, "/add Песня А2"));
  await send(msg(20, g2, "/add Песня Б1"));
  await send(msg(21, g2, "/add Песня Б2"));
  check("песни легли в свои свопы",
    db(`SELECT text FROM songs WHERE swap_id=${S1} ORDER BY id`).map((r) => r.text).join() === "Песня А1,Песня А2" &&
      db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S2}`)[0].n === 2);

  await send(msg(30, priv(30), "Песня В1"));
  check("личка при двух свопах спросила кнопкой", allButtons("pick:add:").length === 2);
  check("текст припрятан в pending", db("SELECT text FROM pending_intake")[0]?.text === "Песня В1");
  await send(cb(30, priv(30), `pick:add:${S1}`));
  check("после кнопки песня в выбранном свопе",
    db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S1} AND user_id=30`)[0].n === 1 &&
      db("SELECT COUNT(*) AS n FROM pending_intake")[0].n === 0);
  await send(msg(30, priv(30), "Песня В2"));
  check("вторая песня автороутингом в тот же своп",
    db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S1} AND user_id=30`)[0].n === 2 &&
      allButtons("pick:add:").length === 2);

  await send(msg(9002, priv(9002), "Песня чужака"));
  await send(cb(9002, priv(9002), `pick:add:${S1}`));
  check("чужак не вступает и через кнопку выбора",
    db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S1} AND user_id=9002`)[0].n === 0 &&
      sentTo(9002).some((o) => o.text.includes("только для участников")));

  await send(msg(40, g1, "/add Песня Г1"));
  await send(msg(40, g2, "/add Песня Г2"));
  await send(msg(40, priv(40), "/leave"));
  check("leave при двух открытых свопах спросил кнопкой", allButtons("pick:leave:").length === 2);
  await send(cb(40, priv(40), `pick:leave:${S2}`));
  check("вышел только из Второго",
    db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S2} AND user_id=40`)[0].n === 0 &&
      db(`SELECT COUNT(*) AS n FROM participants WHERE swap_id=${S1} AND user_id=40`)[0].n === 1);

  await send(msg(ADMIN, g1, "/close"));
  await send(msg(ADMIN, g1, "/draw"));
  await send(msg(20, g2, "/add Песня Б3"));
  check("Первый разыгран, Второй продолжает приём",
    db(`SELECT state FROM swaps WHERE id=${S1}`)[0].state === "drawn" &&
      db(`SELECT state FROM swaps WHERE id=${S2}`)[0].state === "collecting" &&
      db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S2}`)[0].n === 3);

  await send(msg(ADMIN, g2, "/newswap Третий"));
  await send(cb(ADMIN, g2, "newswap:public:Третий"));
  const S3 = db("SELECT id FROM swaps WHERE chat_id=-1002")[0].id;
  check("Второй пересоздан, Первый нетронут",
    db(`SELECT COUNT(*) AS n FROM assignments WHERE swap_id=${S1}`)[0].n === 4 &&
      db(`SELECT COUNT(*) AS n FROM songs WHERE swap_id=${S3}`)[0].n === 0);

  for (const [u, s] of [[30, "Песня В4"], [10, "Песня А3"], [40, "Песня Г3"], [41, "Песня Г4"]]) {
    await send(msg(u, g2, "/add " + s));
  }
  await send(msg(ADMIN, g2, "/close"));
  await send(msg(ADMIN, priv(ADMIN), "/draw"));
  check("приватный draw спросил кнопкой", allButtons("pick:draw:").length === 2);
  await send(cb(ADMIN, priv(ADMIN), `pick:draw:${S3}`));
  check("выбранный своп разыгран", db(`SELECT state FROM swaps WHERE id=${S3}`)[0].state === "drawn");
  checkDrawInvariants(S3, [30, 10, 40, 41], false);
  await send(cb(ADMIN, priv(ADMIN), `draw:${S3}:rerun`));
  checkDrawInvariants(S3, [30, 10, 40, 41], false);

  await send(msg(10, priv(10), "/status"));
  const st = sentTo(10).filter((o) => o.text.includes("Своп"));
  check("статус показывает все свопы участника",
    st.some((o) => o.text.includes("Первый")) && st.some((o) => o.text.includes("Третий")));

  await send(msg(ADMIN, g2, "/newswap Четвёртый"));
  await send(cb(ADMIN, g2, "newswap:public:Четвёртый"));
  const S4 = db("SELECT id FROM swaps WHERE chat_id=-1002")[0].id;
  await send(cb(99, priv(99), `pick:add:${S4}`));
  check("pick:add без отложенных песен просит прислать заново",
    sentTo(99).some((o) => o.text.includes("Не нашёл песен")));
}

async function scenarioEdges() {
  console.log("\n=== Сценарий 4: гварды и крайние случаи ===");
  const g = group(-5001, "Эджи");
  await send(msg(ADMIN, g, "/newswap Эджи"));
  await send(msg(77, g, "/add"));
  check("пустой /add подсказывает формат", sentTo(-5001).some((o) => o.text.includes("Пришли песни")));
  await send(msg(77, g, "/leave"));
  check("leave не-участника", sentTo(-5001).some((o) => o.text.includes("и так не участвуешь")));
  await send(msg(77, g, "/close"));
  await send(msg(77, g, "/newswap Хак"));
  check("админ-команды не-админу закрыты",
    sentTo(-5001).filter((o) => o.text.includes("только для админов")).length >= 2);
  await send(msg(77, priv(77), "/foo"));
  check("неизвестная команда", sentTo(77).some((o) => o.text.includes("Не знаю такую команду")));
  await send(photoMsg(77, priv(77)));
  check("не-текст в личке", sentTo(77).some((o) => o.text.includes("только текстом")));
  await send(msg(77, g, "/status"));
  check("статус в группе отправляет в личку", sentTo(-5001).some((o) => o.text.includes("личке")));
  await send(msg(77, priv(77), "/start"));
  check("стартовое приветствие", sentTo(77).some((o) => o.text.includes("караоке-свопов")));
  await send(msg(77, priv(77), "/help"));
  check("help со списком команд", sentTo(77).some((o) => o.text.includes("/leave")));
  const wrong = await fetch(`http://127.0.0.1:${PORT}/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong" },
    body: JSON.stringify(msg(77, g, "/add hacked")),
  });
  check("вебхук с неверным секретом отклонён", wrong.status === 401);
  const notFound = await fetch(`http://127.0.0.1:${PORT}/nope`);
  check("чужой путь — 404", notFound.status === 404);
}

// ---------- инфраструктура ----------

async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch (e) {
    return !e.message.includes("fetch failed") && !(e.cause?.code === "ECONNREFUSED");
  }
}

async function waitReady() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

async function main() {
  for (const port of [PORT, MOCK_PORT]) {
    if (await portBusy(port)) {
      console.error(`Порт ${port} занят — похоже, уже что-то работает. Освободи и перезапусти.`);
      process.exit(1);
    }
  }

  spawnSync("npx", ["wrangler", "d1", "migrations", "apply", "songswap", "--local"], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });

  const mock = await startMock();
  startWrangler();

  try {
    if (!(await waitReady())) throw new Error("wrangler dev не поднялся за 90 секунд");
    console.log(`стенд готов: воркер :${PORT}, мок Telegram :${MOCK_PORT}`);

    // сброс и перед первым сценарием: прогон должен быть самодостаточным
    // и не зависеть от того, что осталось в локальной D1 с прошлых запусков
    await resetDb();
    await scenarioSinglePublic(); await resetDb();
    await scenarioSecret(); await resetDb();
    await scenarioMultiChat(); await resetDb();
    await scenarioEdges();

    const failed = checks.filter(([, ok]) => !ok).map(([n]) => n);
    console.log(`\n${"=".repeat(60)}`);
    if (failed.length) {
      console.log(`ПРОВАЛЕНО ${failed.length} из ${checks.length}:`);
      failed.forEach((n) => console.log("  ✗ " + n));
      process.exitCode = 1;
    } else {
      console.log(`ВСЕ ${checks.length} ПРОВЕРОК OK`);
    }
  } finally {
    stopWrangler();
    mock.close();
    await sleep(1500);
  }
}

main().catch((e) => {
  console.error("E2E упал:", e);
  console.error("Лог wrangler: " + WRANGLER_LOG_PATH);
  process.exitCode = 1;
});
