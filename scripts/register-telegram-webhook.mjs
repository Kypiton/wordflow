import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export function webhookConfiguration(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Set TELEGRAM_BOT_TOKEN to a valid BotFather token.");
  }
  if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    throw new Error("Set TELEGRAM_WEBHOOK_SECRET to 1–256 letters, digits, underscores, or hyphens.");
  }
  let url;
  try {
    url = new URL(env.TELEGRAM_WEBHOOK_URL);
  } catch {
    throw new Error("Set TELEGRAM_WEBHOOK_URL to a public HTTPS webhook URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Require a public domain, excluding all IP literals and local hostnames.
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search ||
      url.pathname !== "/api/telegram/webhook" ||
      !host.includes(".") || isIP(host) || host.includes(":") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host) ||
      (url.port && !["443", "80", "88", "8443"].includes(url.port))) {
    throw new Error("TELEGRAM_WEBHOOK_URL must use a public HTTPS domain and /api/telegram/webhook; localhost and IP literals are not allowed.");
  }
  return { token, url: url.href, secret };
}

export async function registerWebhook(env = process.env) {
  const { token, url, secret } = webhookConfiguration(env);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, secret_token: secret, allowed_updates: ["message", "widget_query"] }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json();
    if (!response.ok || body?.ok !== true || body.result !== true) throw new Error();
  } catch {
    // Never print Telegram responses or fetch errors containing the token URL.
    throw new Error("Webhook registration failed. Check the bot credentials, public URL, and network connection.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await registerWebhook();
    console.log("Telegram webhook registered successfully.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
