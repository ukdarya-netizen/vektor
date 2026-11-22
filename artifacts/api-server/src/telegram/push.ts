/**
 * Browser push (Web Push, VAPID). Keys: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:…).
 * Generate once: node -e "console.log(require('web-push').generateVAPIDKeys())"
 * A subscription the browser has dropped (404/410) is deleted.
 */
import webpush from "web-push";
import { q } from "../db";

let ready: boolean | null = null;
function setup(): boolean {
  if (ready !== null) return ready;
  const pub = process.env.VAPID_PUBLIC_KEY?.trim(), priv = process.env.VAPID_PRIVATE_KEY?.trim();
  ready = Boolean(pub && priv);
  if (ready) webpush.setVapidDetails(process.env.VAPID_SUBJECT?.trim() || "mailto:support@vektor.app", pub!, priv!);
  return ready;
}
export const pushPublicKey = () => (setup() ? process.env.VAPID_PUBLIC_KEY!.trim() : null);

export async function sendPush(userId: number, title: string, body: string): Promise<number> {
  if (!setup()) return 0;
  const subs = await q<{ id: number; endpoint: string; keys: any }>("SELECT id, endpoint, keys FROM vk_push_subs WHERE user_id = $1", [userId]);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, JSON.stringify({ title, body }), { TTL: 3600 });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await q("DELETE FROM vk_push_subs WHERE id = $1", [s.id]);
    }
  }
  return sent;
}
