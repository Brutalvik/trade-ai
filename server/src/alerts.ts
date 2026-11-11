// Phone alerts for trades, safety limits and a daily summary.
// Configure ONE of these in the server environment (Vercel → Settings → Environment Variables):
//  - Telegram: TELEGRAM_BOT_TOKEN (from @BotFather) and TELEGRAM_CHAT_ID (your chat with the bot)
//  - ntfy:     NTFY_TOPIC (a long random topic name; subscribe to it in the ntfy phone app)
// Alerts never block or break trading: failures are logged and ignored, with a 4 s timeout.

export type AlertChannel = "telegram" | "ntfy" | null;

export function alertChannel(): AlertChannel {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) return "telegram";
  if (process.env.NTFY_TOPIC) return "ntfy";
  return null;
}

export async function sendAlert(text: string): Promise<void> {
  const channel = alertChannel();
  if (!channel) return;
  const signal = AbortSignal.timeout(4000);
  try {
    if (channel === "telegram") {
      await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
        signal,
      });
    } else {
      await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC!)}`, {
        method: "POST",
        headers: { Title: "NEXUS//TRADE" },
        body: text,
        signal,
      });
    }
  } catch (e: any) {
    console.error("[alerts] failed:", e?.message ?? e);
  }
}
