import express from "express";
import cookieParser from "cookie-parser";
import { migrate, q } from "./db";
import { authRouter } from "./routes/auth";
import { accountsRouter, checkAccount } from "./routes/accounts";
import { notificationsRouter } from "./routes/notifications";
import { tradeRouter } from "./routes/trade";
import { managedRouter } from "./routes/managed";
import { startEngine } from "./engine/manager";
import { clientFor } from "./exchanges/client";
import { pump } from "./telegram/outbox";
import { startPolling } from "./telegram/bot";

const REQUIRED = ["DATABASE_URL", "VEKTOR_MASTER_KEY", "VEKTOR_SESSION_SECRET"];
const missing = REQUIRED.filter((k) => !process.env[k]?.trim());
if (missing.length) {
  console.error(`[boot] missing secrets: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

app.get("/api/healthz", (_req, res) => { res.json({ ok: true }); });
app.use("/api/auth", authRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/managed", managedRouter);
app.use("/api", accountsRouter);
app.use("/api", tradeRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[api]", err);
  if (!res.headersSent) res.status(500).json({ error: "server_error" });
});

/** Every 5 minutes: is each connected key still working and still without withdrawal? */
async function healthLoop(): Promise<void> {
  const rows = await q("SELECT * FROM vk_exchange_accounts WHERE status <> 'paused' AND (last_check_at IS NULL OR last_check_at < now() - interval '5 minutes') ORDER BY last_check_at NULLS FIRST LIMIT 20");
  for (const a of rows) await checkAccount(a).catch((e) => console.error("[health]", a.id, e));
}

const port = Number(process.env.PORT ?? 8080);
await migrate();
app.listen(port, "0.0.0.0", () => console.log(`[api] listening on ${port}`));
void pump().catch((e) => console.error("[tg] pump", e));
void startPolling();
if (process.env.ACCOUNT_HEALTH_CHECKS !== "0") setInterval(() => void healthLoop().catch((e) => console.error("[health]", e)), 60_000).unref();
// Position manager: on in production; in development only with ENGINE_ENABLED=1 (a dev copy must not
// manage real positions next to the published one — the DB lock also prevents double handling).
if (process.env.NODE_ENV === "production" ? process.env.ENGINE_ENABLED !== "0" : process.env.ENGINE_ENABLED === "1") {
  startEngine({ client: clientFor });
  console.log("[engine] position manager started");
}
