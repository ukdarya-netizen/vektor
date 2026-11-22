# Vektor — криптотерминал

Читать перед любой работой: `docs/00-owner-requirements.md` (главный), затем `docs/01-manus-spec.md`.

## Правила для агента

- Работать только с production-базой. Dev-базу не использовать.
- Код пишет Claude в GitHub. Агент Replit только подтягивает изменения, ставит зависимости и проверяет запуск — сам код не переписывает, если владелец явно не попросил.
- Схему БД руками не менять. Таблицы создаются миграциями при старте сервера (`artifacts/api-server/src/migrations.ts`, только добавление).
- Тесты не запускать против production-базы (`telegram.test.ts` пишет в базу).
- Секреты не трогать и не печатать.
- Публикует владелец сам.

## Запуск

- `pnpm install`
- API: `pnpm --filter @workspace/api-server run dev` (порт 8080, пути `/api`)
- Веб: `pnpm --filter @workspace/web run dev` (путь `/`)
- Сборка: `pnpm run build`; проверка типов: `pnpm run typecheck`

## Секреты (Replit Secrets)

| Имя | Что это |
|---|---|
| `DATABASE_URL` | Postgres (Replit выдаёт сам) |
| `VEKTOR_MASTER_KEY` | 32 байта base64 — шифрует API-ключи бирж. Потеря = пользователям переподключать биржи. Сгенерировать: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `VEKTOR_SESSION_SECRET` | любая длинная случайная строка — подпись кодов входа и сессий |
| `RESEND_API_KEY`, `MAIL_FROM` | отправка кодов входа (resend.com). `MAIL_FROM` вида `Vektor <login@домен>` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME` | бот уведомлений Vektor (новый бот у @BotFather, не бот Люси) |
| `ENGINE_ENABLED` | движок ведения позиций: в опубликованной версии включён сам (выключить — `0`); в dev выключен (включить — `1`) |
| `ANTHROPIC_API_KEY` | AI-копилот (без ключа кнопка AI отвечает «не настроен»). Модель: `ANTHROPIC_MODEL`, по умолчанию `claude-haiku-5-5` |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | push-уведомления в браузере. Сгенерировать один раз: `node -e "console.log(require('web-push').generateVAPIDKeys())"` в artifacts/api-server; SUBJECT — `mailto:ваша@почта` |
| `VEKTOR_ADMIN_EMAILS` | почты владельцев платформы через запятую — им виден раздел «Пользователи» (выдача и продление подписок) |
| `VEKTOR_BILLING_CONTACT` | куда писать за продлением (например `@lucy_support`), показывается в «Подписке» и в напоминаниях |
| `TELEGRAM_POLLING` | `1` только в опубликованной версии (иначе dev и prod отбирают друг у друга сообщения бота) |

## Структура

- `artifacts/api-server` — Express 5 + pg + CCXT. `src/routes` — HTTP, `src/exchanges` — биржи, `src/engine` — ведение позиций, `src/telegram` — уведомления.
- `artifacts/web` — React 19 + Vite + Tailwind 4. `src/pages`, `src/components`, `src/lib/i18n.tsx` (RU/EN).
