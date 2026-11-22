/**
 * Signal parsing — pure, covered by tests. Accepts:
 *  1) Vektor JSON: {"action":"open","side":"long","symbol":"BTCUSDT","id":"...","sl":"2%","tp":["2%","4%"],"leverage":10,"amount":20}
 *  2) TradingView-style JSON with common aliases (ticker, positionSide, side buy/sell, strategy.order.action text)
 *  3) Plain text: "BUY BTCUSDT", "long BINANCE:SOLUSDT.P", "close ETHUSDT", "exit short BTC"
 * Anything the parser is not sure about is rejected with a reason — never guessed.
 */
export type Action = "open" | "close" | "reverse";
export type Parsed = {
  action: Action;
  side: "long" | "short" | null;
  symbol: string;
  id: string | null;
  time: number | null;
  overrides: {
    amount?: number; amountPct?: number; leverage?: number;
    sl?: { mode: "pct" | "price"; value: number };
    tp?: Array<{ mode: "pct" | "price"; value: number }>;
    closePercent?: number;
  };
};
export type ParseResult = { ok: true; signal: Parsed } | { ok: false; reason: string };

const SIDE: Record<string, "long" | "short"> = { long: "long", buy: "long", short: "short", sell: "short" };

function level(v: unknown): { mode: "pct" | "price"; value: number } | undefined {
  if (v === null || v === undefined || v === "") return undefined;
  const s = String(v).trim();
  const pct = s.endsWith("%");
  const n = Number(s.replace("%", "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return { mode: pct ? "pct" : "price", value: n };
}

const num = (v: unknown) => {
  const n = Number(typeof v === "string" ? v.replace(",", ".") : v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

function parseTime(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  const n = Number(v);
  if (Number.isFinite(n)) return n < 1e12 ? n * 1000 : n;
  const d = Date.parse(String(v));
  return Number.isFinite(d) ? d : null;
}

export function parseSignal(raw: string): ParseResult {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  if (text.length > 8_000) return { ok: false, reason: "too_long" };
  let obj: any = null;
  if (text.startsWith("{")) {
    try { obj = JSON.parse(text); } catch { return { ok: false, reason: "bad_json" }; }
  }
  if (obj) return fromJson(obj);
  // Short command first ("long BTCUSDT"); a longer post goes to the provider-post parser.
  const short = text.length <= 60 && !/\n/.test(text) ? fromText(text) : null;
  return short?.ok ? short : fromPost(text);
}

function fromJson(o: any): ParseResult {
  const symbol = String(o.symbol ?? o.ticker ?? o.pair ?? o.instrument ?? "").trim();
  if (!symbol) return { ok: false, reason: "no_symbol" };
  let actionRaw = String(o.action ?? o.type ?? o.command ?? "").toLowerCase().trim();
  let sideRaw = String(o.side ?? o.positionSide ?? o.direction ?? o.position ?? "").toLowerCase().trim();
  // TradingView strategy placeholders: action = buy/sell, market_position = long/short/flat.
  if (!sideRaw && SIDE[actionRaw]) { sideRaw = actionRaw; actionRaw = "open"; }
  const mp = String(o.market_position ?? o.marketPosition ?? "").toLowerCase();
  if (mp === "flat") actionRaw = "close";

  let action: Action;
  if (!actionRaw || actionRaw === "open" || actionRaw === "entry" || actionRaw === "enter") action = "open";
  else if (["close", "exit", "flat", "tp", "sl"].includes(actionRaw)) action = "close";
  else if (actionRaw === "reverse" || actionRaw === "flip") action = "reverse";
  else return { ok: false, reason: "unknown_action" };

  const side = SIDE[sideRaw] ?? null;
  if (action !== "close" && !side) return { ok: false, reason: "no_side" };
  // A close by "sell" means close the long, by "buy" close the short.
  const closeSide = action === "close" && side && SIDE[sideRaw] && (sideRaw === "buy" || sideRaw === "sell") ? (sideRaw === "sell" ? "long" : "short") : side;

  const tpRaw = o.tp ?? o.takeProfit ?? o.take_profit ?? o.tps;
  const tps = (Array.isArray(tpRaw) ? tpRaw : tpRaw !== undefined ? [tpRaw] : []).map(level).filter(Boolean) as Array<{ mode: "pct" | "price"; value: number }>;
  return {
    ok: true,
    signal: {
      action, side: action === "close" ? closeSide : side, symbol,
      id: o.id !== undefined ? String(o.id).slice(0, 120) : o.signal_id !== undefined ? String(o.signal_id).slice(0, 120) : null,
      time: parseTime(o.time ?? o.timestamp ?? o.timenow),
      overrides: {
        amount: num(o.amount ?? o.margin ?? o.usdt), amountPct: num(o.amountPct ?? o.percent_of_balance),
        leverage: num(o.leverage ?? o.lev), sl: level(o.sl ?? o.stopLoss ?? o.stop_loss ?? o.stop),
        tp: tps.length ? tps : undefined, closePercent: num(o.percent ?? o.closePercent),
      },
    },
  };
}

/**
 * Free-form provider posts (Telegram channels):
 *   "#BTC LONG  Entry 65000-65200  TP1 66000 TP2 67000  SL 64000  Lev 10x"
 *   "🟢 BUY $SOLUSDT … Targets: 150, 155 … Stop: 140"
 * Only what is clearly written is taken; no number is guessed.
 */
export function fromPost(text: string): ParseResult {
  const t = text.replace(/[*_`~|]/g, " ");
  const low = t.toLowerCase();
  const sym = t.match(/[#$]([A-Za-z0-9]{2,15})(?:\/?USDT)?\b/) ?? t.match(/\b([A-Z0-9]{2,15})\/?USDT(?:\.P|PERP)?\b/);
  if (!sym) return { ok: false, reason: "no_symbol" };
  // \b does not work with Cyrillic in JS regex: Russian words are matched without it.
  const isClose = /(?:\b(?:close|closed|exit)|закры|выход|фикс)/i.test(low) && !/(?:\bentry\b|вход)/i.test(low);
  const long = /(?:\b(?:long|buy)|лонг|покуп)/i.test(low) || /🟢/.test(t);
  const short = /(?:\b(?:short|sell)|шорт|прода)/i.test(low) || /🔴/.test(t);
  if (!isClose && long === short) return { ok: false, reason: "no_side" };
  const nums = (re: RegExp) => [...t.matchAll(re)].map((m) => Number(m[1].replace(",", "."))).filter((n) => n > 0);
  const sl = nums(/(?:\bsl|\bstop(?:[-\s]?loss)?|стоп)[^0-9\n]{0,12}([0-9]+[.,]?[0-9]*)/gi)[0];
  let tps = nums(/(?:\btp\s?\d?|take[-\s]?profit\s?\d?|тейк\s?\d?|target\s?\d?|цель\s?\d?)[^0-9\n]{0,8}([0-9]+[.,]?[0-9]*)/gi);
  const targetsLine = t.match(/(?:targets?|цели|тейки)\s*:?\s*([0-9.,\s\-–/]+)/i);
  if (!tps.length && targetsLine) tps = targetsLine[1].split(/[\s\-–/,]+(?=\d)/).map((x) => Number(x.replace(",", "."))).filter((n) => n > 0);
  const lev = nums(/(?:lev(?:erage)?|плечо|x\s?)[^0-9\n]{0,6}([0-9]{1,3})\s?x?/gi)[0] ?? nums(/\b([0-9]{1,3})x\b/gi)[0];
  const base = sym[1].toUpperCase().replace(/USDT$/, "");
  return {
    ok: true,
    signal: {
      action: isClose ? "close" : "open", side: isClose ? (long && !short ? "long" : short && !long ? "short" : null) : long ? "long" : "short",
      symbol: `${base}USDT`, id: null, time: null,
      overrides: {
        sl: sl ? { mode: "price", value: sl } : undefined,
        tp: tps.length ? tps.slice(0, 5).map((v) => ({ mode: "price" as const, value: v })) : undefined,
        leverage: lev && lev <= 125 ? lev : undefined,
      },
    },
  };
}

function fromText(text: string): ParseResult {
  const words = text.replace(/[,;]/g, " ").split(/\s+/).map((w) => w.trim()).filter(Boolean);
  let action: Action = "open";
  let side: "long" | "short" | null = null;
  let symbol: string | null = null;
  for (const w of words) {
    const l = w.toLowerCase();
    if (["close", "exit", "flat"].includes(l)) action = "close";
    else if (["reverse", "flip"].includes(l)) action = "reverse";
    else if (SIDE[l]) side = SIDE[l];
    else if (!symbol && /[a-z]/i.test(w) && /^[A-Z0-9:._/\-]{2,40}$/i.test(w) && !["open", "entry", "market"].includes(l)) symbol = w;
  }
  if (!symbol) return { ok: false, reason: "no_symbol" };
  if (action !== "close" && !side) return { ok: false, reason: "no_side" };
  return { ok: true, signal: { action, side, symbol, id: null, time: null, overrides: {} } };
}

/**
 * Finds the exchange market for a TradingView-style ticker:
 * "BINANCE:BTCUSDT.P" / "BTCUSDT" / "BTC-USDT-SWAP" / "BTC/USDT" / "1000PEPEUSDT" ↔ "PEPE".
 */
export function matchSymbol(raw: string, markets: Array<{ symbol: string; base: string }>): string | null {
  const direct = markets.find((m) => m.symbol === raw);
  if (direct) return direct.symbol;
  let s = raw.toUpperCase().split(":").pop()!;
  s = s.replace(/\.P$|PERP$|-SWAP$|_PERP$/, "").replace(/[-_/]/g, "");
  s = s.replace(/USDT$|USDC$|USD$/, "");
  if (!s) return null;
  const byBase = new Map(markets.map((m) => [m.base.toUpperCase(), m.symbol]));
  for (const cand of [s, `1000${s}`, s.replace(/^1000+/, ""), `1000000${s}`, s.replace(/^1M/, "")]) {
    const hit = byBase.get(cand);
    if (hit) return hit;
  }
  return null;
}
