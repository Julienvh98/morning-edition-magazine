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
const testMode = process.argv.includes("--test") || process.env.TELEGRAM_TEST === "1";

if (!token || !chatId) {
  console.log("Telegram env vars are not configured; skipping TLDR AI notification.");
  process.exit(0);
}

if (!looksLikeBotToken(token)) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN does not look like a real Telegram bot token. " +
      "Edit `.env.local` and replace the example value with the token from @BotFather."
  );
}

if (testMode) {
  await sendMessage({
    token,
    chatId,
    text: `TLDR AI Reader Telegram test from ${new Date().toLocaleString("en-GB", { timeZone: "Europe/London" })}`
  });
  console.log(`Sent TLDR AI Telegram test to chat ${maskChatId(chatId)}`);
  process.exit(0);
}

try {
  await access(issuePath);
} catch {
  throw new Error(
    `TLDR AI issue does not exist: ${issuePath}\n` +
      "Run the TLDR AI Reader automation first, or save the latest TLDR AI email body to data/tldr-ai/raw/latest.md and run `npm run generate:tldr-ai` before `npm run notify:tldr-ai`."
  );
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

async function sendMessage({ token, chatId, text }) {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ chat_id: chatId, text })
  });

  if (!response.ok) {
    const body = await response.text();
    const hint =
      response.status === 401
        ? " The bot token is invalid or was revoked. Generate/copy a fresh token from @BotFather and update `.env.local`."
        : "";
    throw new Error(`Telegram test failed with ${response.status}: ${body}${hint}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(`Telegram test failed: ${JSON.stringify(result)}`);
  }
}

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

function looksLikeBotToken(value) {
  return /^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(String(value).trim());
}
