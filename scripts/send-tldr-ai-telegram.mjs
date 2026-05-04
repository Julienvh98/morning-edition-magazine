import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

await loadDotEnv(path.join(root, ".env.local"));
await loadDotEnv(path.join(root, ".env"));

const token = process.env.TELEGRAM_BOT_TOKEN || process.env.TLDR_TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID || process.env.TLDR_TELEGRAM_CHAT_ID;
const issueDate = process.env.TLDR_AI_ISSUE_DATE || formatDateInZone(new Date(), "Europe/London");
const issuePath = path.resolve(root, process.env.TLDR_AI_ISSUE_PATH || path.join("tldr-magazines", `${issueDate}.html`));

if (!token || !chatId) {
  console.log("Telegram env vars are not configured; skipping TLDR AI notification.");
  process.exit(0);
}

try {
  await access(issuePath);
} catch {
  throw new Error(`TLDR AI issue does not exist: ${issuePath}`);
}

const caption = `TLDR AI Reader is ready: ${path.basename(issuePath)}`;
const form = new FormData();
form.set("chat_id", chatId);
form.set("caption", caption);
form.set("document", new File([await readFile(issuePath)], path.basename(issuePath), { type: "text/html" }));

const response = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
  method: "POST",
  body: form
});

if (!response.ok) {
  const body = await response.text();
  throw new Error(`Telegram send failed with ${response.status}: ${body}`);
}

const result = await response.json();
if (!result.ok) {
  throw new Error(`Telegram send failed: ${JSON.stringify(result)}`);
}

console.log(`Sent TLDR AI issue to Telegram chat ${maskChatId(chatId)}`);

async function loadDotEnv(filePath) {
  let content;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
  }
}

function formatDateInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function maskChatId(value) {
  const text = String(value);
  if (text.length <= 4) return "****";
  return `${text.slice(0, 2)}***${text.slice(-2)}`;
}
