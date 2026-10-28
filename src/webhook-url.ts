/** Hosts Discord serves webhooks from (stable, PTB and Canary clients copy URLs with their own host). */
const WEBHOOK_HOSTS = new Set([
  'discord.com', 'ptb.discord.com', 'canary.discord.com',
  'discordapp.com', 'ptb.discordapp.com', 'canary.discordapp.com',
]);
const WEBHOOK_PATH = /^\/api(?:\/v\d{1,2})?\/webhooks\/(\d{1,30})\/([A-Za-z0-9_-]{1,200})\/?$/;
const TOKEN_PATTERN = /webhooks\/\d+\/([A-Za-z0-9_-]+)/;

/**
 * Returns the canonical webhook URL when `value` is an https Discord webhook URL, otherwise undefined.
 * Query strings, fragments, credentials and custom ports are rejected so nothing but Discord's host can be reached.
 */
export function parseWebhookUrl(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try { url = new URL(text); } catch { return undefined; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return undefined;
  if (!WEBHOOK_HOSTS.has(url.hostname)) return undefined;
  const match = WEBHOOK_PATH.exec(url.pathname);
  return match ? `https://${url.hostname}/api/webhooks/${match[1]}/${match[2]}` : undefined;
}

/** Strings that must never appear in logs or reports: the configured value, its canonical form and the token. */
export function webhookSecrets(value: string | undefined): string[] {
  const text = value?.trim();
  if (!text) return [];
  const canonical = parseWebhookUrl(text);
  const token = TOKEN_PATTERN.exec(text)?.[1];
  return [...new Set([text, ...(canonical ? [canonical] : []), ...(token ? [token] : [])])];
}
