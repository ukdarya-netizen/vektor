# VECTOR ↔ сигнальные боты

Секрет `VECTOR_BOTS_SECRET` одинаковый в VECTOR и в каждом боте. Каждый запрос подписан:
заголовки `x-vector-timestamp` (мс) и `x-vector-signature` = hex HMAC-SHA256 от `"<timestamp>.<тело>"`
(для GET вместо тела — путь с query, например `/api/vector/access?telegramId=123`). Запросы старше 5 минут отклоняются.

## Что делает бот (VECTOR → бот)

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/api/vector/grant` | `{ telegramId, until (ISO), ref }` → открыть/продлить доступ этому Telegram ID до `until` (как «Одобрить» у владельца). Повтор с тем же `ref` — без двойного продления. Ответ `{ ok: true }` |
| GET | `/api/vector/access?telegramId=` | `{ active, until }` — есть ли у человека подписка, купленная прямо в боте |
| GET | `/api/vector/stats` | `{ periods: [{ key: "1m"\|"6m"\|"12m", from, to, signals, winRatePct, pnlPct }], updatedAt }` — только закрытые сделки |

## Сигналы (бот → VECTOR)

`POST https://<vector>/api/provider/<cab|nihilist|bmm>` с той же подписью, тело JSON:

```json
{ "action": "open", "symbol": "SOLUSDT", "side": "long", "entry": 140.2, "sl": 135.1, "tp": [145, 150], "id": "sig-123", "time": 1732280000000 }
{ "action": "move_stop", "symbol": "SOLUSDT", "side": "long", "sl": 140.2, "id": "sig-123-be" }
{ "action": "close", "symbol": "SOLUSDT", "side": "long", "id": "sig-123-close" }
```

VECTOR раздаёт сигнал всем, у кого оплачена автоторговля этого бота, активен терминал и есть доступ к сигналам
(куплен в VECTOR или прямо в боте). `close` и `move_stop` доходят всегда — открытые сделки ведутся и после окончания подписки.
