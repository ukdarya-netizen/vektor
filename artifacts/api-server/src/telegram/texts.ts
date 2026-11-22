/**
 * Telegram texts. Plain text, no HTML. Ported from Lucy's Trading Bot (executor/texts.ts):
 * messages say what really happened. A close is named from two facts — why the stop stood
 * where it stood (stop kind, set on every move) and the real result of the fills.
 * A stop trailed into profit is never called a stop-loss; a cancelled signal is never a stop.
 */
export type Lang = "ru" | "en";
export type Msg = Record<Lang, string>;
export type Side = "long" | "short";

/** Why the stop stands where it stands. */
export type StopKind = "initial" | "breakeven" | "trailing" | "manual" | "source";

/** Within ±this % of the entry a result or a stop counts as break-even (fees, ticks). */
export const FLAT_PCT = 0.3;

const sign = (v: number) => (v > 0 ? "+" : v < 0 ? "−" : "");
export const pct = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${sign(v)}${Math.abs(v).toFixed(2)}%`;
export const fmt = (v: number | null | undefined, d = 6) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : String(Number(v.toPrecision(d)));
export const money = (v: number | null | undefined, asset: string) =>
  v === null || v === undefined || !Number.isFinite(v) ? "—" : `${sign(v)}${Math.abs(v).toFixed(2)} ${asset}`;
export const movePct = (side: Side, entry: number, price: number) => ((price - entry) / entry) * 100 * (side === "long" ? 1 : -1);

const both = (ru: string, en: string): Msg => ({ ru, en });
const join = (lines: Array<string | null | undefined | false>) => lines.filter(Boolean).join("\n");

/** First line of every trade message: «Источник · Монета · Биржа/счёт». */
export const head = (source: string, coin: string, account: string) => `${source} · ${coin.replace(/[-/:]?USDT.*$/, "")} · ${account}`;

/** Close key from a stop fill. */
export function stopCloseKey(kind: StopKind, resultPct: number | null): string {
  const r = resultPct ?? 0;
  if (r <= -FLAT_PCT) {
    if (kind === "initial" || kind === "manual") return "stop_loss";
    if (kind === "trailing") return "stop_trailing_loss";
    return "stop_breakeven_slip";
  }
  if (r < FLAT_PCT) return "stop_breakeven";
  if (kind === "trailing") return "stop_trailing_profit";
  if (kind === "breakeven") return "stop_breakeven_plus";
  if (kind === "source") return "stop_source_profit";
  return "stop_profit";
}

/** One line: how the position was closed. */
export function closeLine(key: string, ctx: { source?: string; takeN?: number | null } = {}): Msg {
  const src = ctx.source ?? "";
  switch (key) {
    case "stop_loss": return both("Сработал стоп-лосс", "Stop-loss hit");
    case "stop_trailing_loss": return both("Сработал подтянутый стоп (трейлинг) — итог ещё в минусе", "Trailed stop hit — result still negative");
    case "stop_breakeven_slip": return both("Сработал стоп в безубытке, исполнение с проскальзыванием в минус", "Break-even stop hit, filled with slippage into a loss");
    case "stop_breakeven": return both("Закрыта в безубыток: сработал стоп на уровне входа", "Closed at break-even: stop at entry hit");
    case "stop_trailing_profit": return both("Сработал трейлинг-стоп — прибыль зафиксирована", "Trailing stop hit — profit locked in");
    case "stop_breakeven_plus": return both("Сработал стоп в безубытке — закрыта в небольшом плюсе", "Break-even stop hit — closed slightly in profit");
    case "stop_source_profit": return both(`Сработал стоп в прибыли (передвинут ${src || "источником"}) — прибыль зафиксирована`, `Stop in profit hit (moved by ${src || "the source"}) — profit locked in`);
    case "stop_profit": return both("Сработал стоп — закрыта в плюсе", "Stop hit — closed in profit");
    case "take": return both(`Тейк${ctx.takeN ? ` ${ctx.takeN}` : ""} исполнен — прибыль зафиксирована`, `Take-profit${ctx.takeN ? ` ${ctx.takeN}` : ""} filled — profit taken`);
    case "take_partial": return both("Частичная фиксация прибыли", "Partial take-profit");
    case "liquidation": return both("ЛИКВИДАЦИЯ позиции", "Position LIQUIDATED");
    case "manual": return both("Закрыта вручную на бирже", "Closed manually on the exchange");
    case "terminal": return both("Закрыта вами в терминале", "Closed by you in the terminal");
    case "signal_close": return both(`${src || "Сигнал"}: команда на закрытие — закрыта по рынку`, `${src || "Signal"}: close command — closed at market`);
    case "signal_cancel": return both(`${src || "Источник"} отменил сигнал — закрыта по рынку`, `${src || "The source"} cancelled the signal — closed at market`);
    case "no_margin_for_stop": return both("Не хватило свободной маржи, чтобы увести ликвидацию за стоп — закрыта по рынку", "Not enough free margin to move liquidation beyond the stop — closed at market");
    case "liquidation_before_stop": return both("Ликвидация осталась раньше стопа — закрыта по рынку, чтобы не потерять больше стопа", "Liquidation was before the stop — closed at market to never lose more than the stop");
    case "protection_failed": return both("Стоп не удалось выставить на бирже — позиция закрыта по рынку", "Stop could not be placed on the exchange — position closed at market");
    case "stop_passed": return both("Цена уже прошла новый стоп — закрыта по рынку", "Price had already passed the new stop — closed at market");
    default: return both(key, key);
  }
}

/** Price move in %, money NET of fees; fees shown when known. */
export function resultLine(resultPct: number | null, pnl: number | null, asset: string, fees: number | null = null): Msg {
  if (resultPct === null && pnl === null) return both("Результат: биржа не вернула цену выхода", "Result: the exchange did not return the exit price");
  const v = resultPct === null ? null : resultPct >= FLAT_PCT ? 1 : resultPct <= -FLAT_PCT ? -1 : 0;
  const ru = [resultPct === null ? "" : `${pct(resultPct)} цены`, pnl === null ? "" : `${money(pnl, asset)}${fees ? ` чистыми (комиссии ${Math.abs(fees).toFixed(2)})` : ""}`].filter(Boolean).join(" · ");
  const en = [resultPct === null ? "" : `${pct(resultPct)} price`, pnl === null ? "" : `${money(pnl, asset)}${fees ? ` net (fees ${Math.abs(fees).toFixed(2)})` : ""}`].filter(Boolean).join(" · ");
  return both(
    `Итог${v === 1 ? " в плюсе" : v === -1 ? " в минусе" : v === 0 ? " около нуля" : ""}: ${ru}`,
    `Result${v === 1 ? " in profit" : v === -1 ? " in loss" : v === 0 ? " near zero" : ""}: ${en}`,
  );
}

export function stopMoveLine(kind: StopKind, movedPct: number, source = ""): Msg {
  const w = `${pct(movedPct)}`;
  switch (kind) {
    case "breakeven": return both(`Стоп перенесён в безубыток (${w} от входа, с учётом комиссий)`, `Stop moved to break-even (${w} from entry, fees included)`);
    case "trailing": return movedPct > 0
      ? both(`Трейлинг-стоп подтянут: ${w} от входа — эта прибыль уже защищена`, `Trailing stop raised: ${w} from entry — this profit is now protected`)
      : both(`Стоп подтянут (трейлинг): ${w} от входа`, `Stop trailed: ${w} from entry`);
    case "source": return both(`${source || "Источник"} передвинул стоп: ${w} от входа`, `${source || "The source"} moved the stop: ${w} from entry`);
    case "manual": return both(`Вы передвинули стоп: ${w} от входа`, `You moved the stop: ${w} from entry`);
    default: return both(`Стоп передвинут: ${w} от входа`, `Stop moved: ${w} from entry`);
  }
}

/** Reasons a position was not opened — what happened and what to do. */
export const NOT_OPENED: Record<string, Msg> = {
  stale: both("сигнал пришёл слишком поздно — срок жизни истёк", "the signal arrived too late — it expired"),
  duplicate: both("такой сигнал уже исполнялся (повтор)", "this signal was already executed (duplicate)"),
  already_in_position: both("по монете уже открыта позиция", "a position in this coin is already open"),
  no_symbol: both("монеты нет на этой бирже", "this coin is not listed on this exchange"),
  stop_beyond_price: both("цена уже за стопом", "price is already beyond the stop"),
  no_funds: both("не хватает свободной маржи", "not enough free margin"),
  below_min_quantity: both("размер меньше минимального лота биржи", "size is below the exchange minimum lot"),
  below_min_notional: both("сумма меньше минимальной на бирже", "amount is below the exchange minimum"),
  risk_limit: both("превышен ваш риск-лимит", "your risk limit would be exceeded"),
  position_mode: both("на бирже не тот режим позиций (нужен раздельный / Hedge) — переключите в настройках фьючерсов биржи", "wrong position mode on the exchange (Hedge needed) — switch it in the exchange futures settings"),
  liquidation_before_stop: both("ликвидация оказалась бы раньше стопа", "liquidation would come before the stop"),
  rejected: both("биржа отклонила ордер", "the exchange rejected the order"),
  source_disabled: both("бот выключен", "the bot is turned off"),
  side_disabled: both("эта сторона (лонг/шорт) в боте выключена", "this side (long/short) is turned off in the bot"),
  opposite_open: both("открыта позиция в обратную сторону", "a position in the opposite direction is open"),
  kill_switch: both("включён аварийный выключатель — новые входы запрещены", "the kill switch is on — no new entries"),
  max_leverage: both("плечо выше вашего лимита", "leverage is above your limit"),
  max_margin: both("маржа выше вашего лимита на сделку", "margin is above your per-trade limit"),
  max_positions: both("достигнут ваш лимит открытых позиций", "your open-positions limit is reached"),
  daily_loss: both("достигнут ваш дневной лимит убытка", "your daily loss limit is reached"),
  parse_error: both("сигнал не удалось разобрать", "the signal could not be parsed"),
  account_paused: both("счёт на паузе", "the account is paused"),
  plan_invalid: both("стоп или тейк по неверную сторону от цены входа", "stop or take-profit on the wrong side of the entry"),
  leverage_failed: both("биржа не дала поставить плечо", "the exchange refused the leverage"),
  exchange_error: both("ошибка биржи", "exchange error"),
};

export const T = {
  opened: (h: string, o: { side: Side; entry: number; qty: number; leverage: number | null; margin: number | null; stop: number | null; liq: number | null; takes: Array<{ price: number; closePct: number }>; managedBy: string | null; delayS: number | null }): Msg => {
    const stopPct = o.stop ? movePct(o.side, o.entry, o.stop) : null;
    const takes = o.takes.map((t, i) => `TP${i + 1} ${fmt(t.price)} (${pct(movePct(o.side, o.entry, t.price))}, ${t.closePct}%)`).join(", ");
    return both(
      join([h, `Открыт ${o.side === "long" ? "лонг" : "шорт"}: вход ${fmt(o.entry)}, объём ${fmt(o.qty)}`,
        o.stop ? `Стоп ${fmt(o.stop)} (${pct(stopPct)}) · ликвидация ${fmt(o.liq)}` : `Стопа нет · ликвидация ${fmt(o.liq)}`,
        `Маржа ${fmt(o.margin, 4)} · плечо ${o.leverage ?? "—"}x`,
        takes ? `Тейки: ${takes}` : "Тейков нет",
        o.managedBy ? `Ведёт: ${o.managedBy}` : null,
        o.delayS !== null ? `Ордер отправлен через ${o.delayS.toFixed(1)} с после сигнала` : null]),
      join([h, `Opened ${o.side}: entry ${fmt(o.entry)}, size ${fmt(o.qty)}`,
        o.stop ? `Stop ${fmt(o.stop)} (${pct(stopPct)}) · liquidation ${fmt(o.liq)}` : `No stop · liquidation ${fmt(o.liq)}`,
        `Margin ${fmt(o.margin, 4)} · leverage ${o.leverage ?? "—"}x`,
        takes ? `Take-profits: ${takes}` : "No take-profits",
        o.managedBy ? `Managed by: ${o.managedBy}` : null,
        o.delayS !== null ? `Order sent ${o.delayS.toFixed(1)} s after the signal` : null]),
    );
  },
  notOpened: (h: string, reason: string, detail = ""): Msg => {
    const r = NOT_OPENED[reason] ?? both(reason, reason);
    return both(join([h, "Позиция не открыта.", `Причина: ${r.ru}${detail ? ` (${detail})` : ""}`]), join([h, "Position not opened.", `Reason: ${r.en}${detail ? ` (${detail})` : ""}`]));
  },
  partial: (h: string, o: { reason: Msg; closed: number; initial: number; atPct: number | null; left: number; stop: number | null; stopPct: number | null }): Msg => both(
    join([h, `${o.reason.ru}: закрыто ${fmt(o.closed)} из ${fmt(o.initial)}${o.atPct !== null ? ` при ${pct(o.atPct)} от входа` : ""}.`, `Осталось ${fmt(o.left)}, стоп ${fmt(o.stop)} (${pct(o.stopPct)} от входа).`]),
    join([h, `${o.reason.en}: closed ${fmt(o.closed)} of ${fmt(o.initial)}${o.atPct !== null ? ` at ${pct(o.atPct)} from entry` : ""}.`, `Left ${fmt(o.left)}, stop ${fmt(o.stop)} (${pct(o.stopPct)} from entry).`]),
  ),
  stopMoved: (h: string, line: Msg, stop: number): Msg => both(join([h, line.ru, `Новый стоп: ${fmt(stop)}`]), join([h, line.en, `New stop: ${fmt(stop)}`])),
  closed: (h: string, o: { side: Side; reason: Msg; entry: number | null; exit: number | null; avgExit: number | null; parts: number; result: Msg; hadPartials: boolean }): Msg => both(
    join([`${h} · ${o.side === "long" ? "лонг" : "шорт"}`, `Позиция закрыта. ${o.reason.ru}.`,
      `Вход ${fmt(o.entry)} → выход ${fmt(o.exit)}${o.parts > 1 ? ` (средний выход по всем частям ${fmt(o.avgExit)})` : ""}`,
      o.result.ru + (o.hadPartials ? " — с учётом частичных закрытий" : "")]),
    join([`${h} · ${o.side}`, `Position closed. ${o.reason.en}.`,
      `Entry ${fmt(o.entry)} → exit ${fmt(o.exit)}${o.parts > 1 ? ` (average exit over all parts ${fmt(o.avgExit)})` : ""}`,
      o.result.en + (o.hadPartials ? " — partial closes included" : "")]),
  ),
  dcaFilled: (h: string, ns: number[], avg: number, size: number): Msg => both(
    join([h, `Сработал страховочный ордер ${ns.join(", ")} — позиция усреднена.`, `Средний вход ${fmt(avg)}, объём ${fmt(size)}. Тейки пересчитаны от новой средней, стоп на месте.`]),
    join([h, `Safety order ${ns.join(", ")} filled — position averaged.`, `Average entry ${fmt(avg)}, size ${fmt(size)}. Take-profits recalculated from the new average, stop unchanged.`]),
  ),
  signalReceived: (bot: string, text: string): Msg => both(`📥 ${bot}: сигнал получен — ${text}`, `📥 ${bot}: signal received — ${text}`),
  reconcileFixed: (h: string, what: Msg): Msg => both(join([h, "Сверка с биржей: найдено расхождение и исправлено.", what.ru]), join([h, "Exchange reconciliation: a mismatch was found and fixed.", what.en])),
  exchangeProblem: (label: string, code: string): Msg => {
    const why: Record<string, Msg> = {
      auth: both("ключ API не принимается биржей (удалён, истёк или неверный)", "the API key is rejected (deleted, expired or wrong)"),
      permission: both("у ключа не хватает прав", "the key lacks permissions"),
      withdraw: both("у ключа включено право ВЫВОДА средств — торговля по нему остановлена. Создайте ключ без вывода", "the key has WITHDRAWAL permission — trading on it is stopped. Create a key without withdrawal"),
      suspended: both("аккаунт на бирже заблокирован", "the exchange account is suspended"),
      network: both("биржа не отвечает", "the exchange does not respond"),
      maintenance: both("на бирже техработы", "the exchange is under maintenance"),
      rate_limit: both("биржа ограничила частоту запросов", "the exchange is rate-limiting requests"),
    };
    const w = why[code] ?? both("ошибка биржи", "exchange error");
    return both(`⚠️ ${label}: ${w.ru}.\nНовые сделки по этому счёту не открываются, пока связь не восстановится.`,
      `⚠️ ${label}: ${w.en}.\nNo new trades on this account until the connection is back.`);
  },
  exchangeRestored: (label: string): Msg => both(`✅ ${label}: связь с биржей восстановлена.`, `✅ ${label}: exchange connection restored.`),
  linked: (email: string): Msg => both(`✅ Telegram подключён к аккаунту Vektor ${email}.\n\nСюда будут приходить уведомления о сделках. Настроить, какие именно, — в Настройки → Уведомления.`,
    `✅ Telegram is connected to the Vektor account ${email}.\n\nTrade notifications will come here. Choose which ones in Settings → Notifications.`),
  unlinked: both("Telegram отключён от аккаунта Vektor. Уведомления больше не приходят.", "Telegram is disconnected from the Vektor account. No more notifications."),
  startNoToken: both("👋 Это бот уведомлений Vektor.\n\nЧтобы подключить его, откройте в терминале Настройки → Уведомления → «Подключить Telegram».",
    "👋 This is the Vektor notification bot.\n\nTo connect it, open Settings → Notifications → “Connect Telegram” in the terminal."),
  linkExpired: both("Ссылка устарела. Нажмите «Подключить Telegram» в терминале ещё раз.", "The link has expired. Press “Connect Telegram” in the terminal again."),
  test: both("🔔 Тестовое уведомление Vektor. Если вы это видите — всё работает.", "🔔 Vektor test notification. If you see this, it works."),
};
