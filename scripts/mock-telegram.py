#!/usr/bin/env python3
"""Мок Telegram Bot API для локальной разработки.

Отвечает 200/ok на любой метод и пишет все входящие запросы в лог-файл,
чтобы видеть, что именно бот отправляет участникам.

Запуск: python3 scripts/mock-telegram.py [порт] [лог-файл]
По умолчанию: порт 8788, лог /tmp/telegram-mock.log
"""
import json
import sys
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8788
LOG_PATH = sys.argv[2] if len(sys.argv) > 2 else "/tmp/telegram-mock.log"


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = self.rfile.read(length).decode("utf-8")
        method = self.path.rsplit("/", 1)[-1]
        with open(LOG_PATH, "a", encoding="utf-8") as log:
            log.write(json.dumps({"method": method, "body": body}, ensure_ascii=False) + "\n")

        # Правило для тестов: user_id >= 9000 — не участник чата, остальные — member.
        result = {"message_id": 1, "date": 0, "chat": {"id": 1, "type": "private"}, "text": ""}
        if method == "getChatMember":
            params = urllib.parse.parse_qs(body)
            user_id = int(params.get("user_id", ["0"])[0])
            status = "left" if user_id >= 9000 else "member"
            result = {"status": status, "user": {"id": user_id, "is_bot": False, "first_name": "U"}}
        elif method == "getChat":
            result = {"id": -100, "type": "supergroup", "title": "Мок-чат"}

        payload = json.dumps({"ok": True, "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    print(f"mock telegram api on http://127.0.0.1:{PORT}, log: {LOG_PATH}")
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
