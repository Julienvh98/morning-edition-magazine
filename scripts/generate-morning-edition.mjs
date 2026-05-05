import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "config", "morning-edition.json");
const outputDir = path.join(root, "magazines");

const HN_URL = "https://news.ycombinator.com/";
const ITEM_URL = "https://news.ycombinator.com/item?id=";
const THEMES = [
  "hero",
  "midnight",
  "rose-alert-stamp",
  "terminal",
  "academic-drop-cap",
  "blueprint",
  "health-note",
  "finance-ledger",
  "weird-lab",
  "big-stat-finish"
];

const config = JSON.parse(await readFile(configPath, "utf8"));
const issueDate = process.env.ISSUE_DATE || formatDateInZone(new Date(), config.timezone);

await mkdir(outputDir, { recursive: true });

const frontPage = await fetchHackerNewsFrontPage();
const curated = curateStories(frontPage, config).slice(0, 10);

if (curated.length === 0) {
  throw new Error("No Hacker News stories were parsed from the front page.");
}

const stories = await enrichStoriesWithSummaries(curated, config);

const html = renderIssue({ config, issueDate, stories });
const outputPath = path.join(outputDir, `${issueDate}.html`);
await writeFile(outputPath, html, "utf8");
await writeFile(path.join(outputDir, "index.html"), renderIndex({ config, issueDate }), "utf8");

console.log(`Wrote ${path.relative(root, outputPath)}`);

async function fetchHackerNewsFrontPage() {
  const response = await fetch(HN_URL, {
    headers: {
      "user-agent": "MorningEditionBot/1.0 (+https://github.com/)"
    }
  });

  if (!response.ok) {
    throw new Error(`Hacker News responded with ${response.status}`);
  }

  const html = await response.text();
  return parseHackerNews(html);
}

function parseHackerNews(html) {
  const rowPattern =
    /<tr class=['"]athing[^'"]*['"][^>]*id=['"](?<id>\d+)['"][^>]*>(?<story>[\s\S]*?)<\/tr>\s*<tr[^>]*>\s*<td colspan=['"]2['"]><\/td>\s*<td class=['"]subtext['"]>(?<subtext>[\s\S]*?)<\/td>\s*<\/tr>/g;
  const stories = [];
  let match;

  while ((match = rowPattern.exec(html))) {
    const { id, story, subtext } = match.groups;
    const rank = Number(firstMatch(story, /<span class=['"]rank['"]>(\d+)\./));
    const title = decodeHtml(firstMatch(story, /<span class=['"]titleline['"]>\s*<a[^>]*>([\s\S]*?)<\/a>/));
    const rawUrl = decodeHtml(firstMatch(story, /<span class=['"]titleline['"]>\s*<a href=['"]([^'"]+)['"]/));
    const site = decodeHtml(firstMatch(story, /<span class=['"]sitestr['"]>([\s\S]*?)<\/span>/));
    const score = Number(firstMatch(subtext, /<span class=['"]score['"][^>]*>(\d+) points?<\/span>/) || 0);
    const author = decodeHtml(firstMatch(subtext, /<a href=['"]user\?id=[^'"]+['"][^>]*>([\s\S]*?)<\/a>/));
    const age = decodeHtml(firstMatch(subtext, /<span class=['"]age['"][^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/));
    const commentsText = decodeHtml(firstMatch(subtext, /<a href=['"]item\?id=\d+['"]>([^<]*(?:comments?|discuss))/));
    const comments = commentsText.includes("comment") ? Number(commentsText.match(/\d+/)?.[0] || 0) : 0;

    if (!id || !title || !rawUrl) continue;

    stories.push({
      id,
      rank: Number.isFinite(rank) ? rank : stories.length + 1,
      title,
      url: absolutizeUrl(rawUrl),
      site: site || "news.ycombinator.com",
      score,
      author,
      age,
      comments,
      hnUrl: `${ITEM_URL}${id}`
    });
  }

  return stories;
}

function curateStories(stories, cfg) {
  return stories
    .map((story) => {
      const haystack = `${story.title} ${story.site}`.toLowerCase();
      const matches = cfg.tasteProfile
        .map((category) => {
          const hits = category.keywords.filter((keyword) => haystack.includes(keyword.toLowerCase()));
          return hits.length ? { label: category.label, weight: category.weight, hits } : null;
        })
        .filter(Boolean);

      const tasteScore = matches.reduce((sum, match) => sum + match.weight + Math.min(match.hits.length - 1, 3) * 5, 0);
      const frontPageScore = Math.max(0, 31 - story.rank) * 1.2;
      const momentumScore = Math.log10(story.score + 10) * 8 + Math.log10(story.comments + 3) * 5;
      const curationScore = tasteScore + frontPageScore + momentumScore;
      const tags = matches.map((match) => match.label);
      const appliesToReader = tags.some((tag) => cfg.directApplyTags.includes(tag)) && (tags.includes("Actionable") || story.rank <= 12 || story.score >= 100);

      return {
        ...story,
        tags: tags.length ? tags : ["HN Signal"],
        matchedWords: [...new Set(matches.flatMap((match) => match.hits))],
        curationScore,
        appliesToReader,
        why: buildWhy({ story, tags, matchedWords: matches.flatMap((match) => match.hits), appliesToReader })
      };
    })
    .sort((a, b) => b.curationScore - a.curationScore || a.rank - b.rank);
}

function buildWhy({ story, tags, matchedWords, appliesToReader }) {
  const signals = [];
  if (tags.length) signals.push(tags.join(" + "));
  if (matchedWords.length) signals.push(`matched on ${[...new Set(matchedWords)].slice(0, 4).join(", ")}`);
  if (story.score) signals.push(`${story.score} HN points`);
  if (story.comments) signals.push(`${story.comments} comments`);
  const base = signals.length ? signals.join("; ") : "front-page momentum";
  return appliesToReader ? `${base}. Directly useful for your AI-forward, practical morning scan.` : `${base}. Worth a quick editorial pass.`;
}

async function enrichStoriesWithSummaries(stories, cfg) {
  const enriched = [];

  for (const story of stories) {
    const sourceText = await fetchStoryText(story).catch((error) => {
      console.warn(`Could not fetch article text for ${story.id}: ${error.message}`);
      return "";
    });
    const summary = await summarizeStory({ story, sourceText, cfg }).catch((error) => {
      console.warn(`Could not summarize ${story.id}: ${error.message}`);
      return fallbackSummary({ story, sourceText, cfg });
    });

    enriched.push({
      ...story,
      sourceText,
      summary,
      summaryWordCount: countWords(summary)
    });
  }

  return enriched;
}

async function fetchStoryText(story) {
  if (story.url.includes("news.ycombinator.com/item")) {
    return `Hacker News discussion for "${story.title}" with ${story.score} points and ${story.comments} comments. ${story.why}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(story.url, {
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "user-agent": "MorningEditionBot/1.0 (+https://github.com/Julienvh98/morning-edition-magazine)"
      }
    });

    if (!response.ok) {
      throw new Error(`article responded with ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await response.text();
    if (contentType.includes("text/plain")) return normalizeWhitespace(body).slice(0, 12000);
    return extractReadableText(body).slice(0, 12000);
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeStory({ story, sourceText, cfg }) {
  if (!process.env.OPENAI_API_KEY || !sourceText || countWords(sourceText) < 80) {
    return fallbackSummary({ story, sourceText, cfg });
  }

  const wordTarget = Number(cfg.summaryWordTarget || 200);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_SUMMARY_MODEL || cfg.summaryModel || "gpt-5-mini",
      instructions:
        "You write concise editorial magazine briefs for a personal Hacker News morning edition. " +
        "Use only the provided article text and metadata. Do not invent facts. Do not mention that text was provided. " +
        `Write one self-contained summary of ${wordTarget - 10}-${wordTarget + 10} words.`,
      input:
        `Title: ${story.title}\n` +
        `Source: ${story.site}\n` +
        `HN signal: ${story.score} points, ${story.comments} comments, rank ${story.rank}\n` +
        `Why selected: ${story.why}\n\n` +
        `Article text:\n${sourceText.slice(0, 10000)}`
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI responded with ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI response did not include output text");
  return trimToWordWindow(text, wordTarget);
}

function fallbackSummary({ story, sourceText, cfg }) {
  const wordTarget = Number(cfg.summaryWordTarget || 200);
  const text = normalizeWhitespace(sourceText || "");
  const fallback = [
    text,
    `${story.title} appears on the Hacker News front page from ${story.site}.`,
    `The item is ranked ${story.rank}, has ${story.score} points and ${story.comments} comments, and was selected because ${story.why}`,
    "The available article text may be limited if the source is a dynamic page, repository, PDF, or short announcement, so this brief combines the readable source material with Hacker News context.",
    "For the morning scan, treat it as a pointer to inspect the original source, then use the HN thread to test the idea against objections, implementation details, and practical edge cases."
  ]
    .filter(Boolean)
    .join(" ");

  return fitToWordCount(fallback, wordTarget);
}

function extractReadableText(html) {
  const metaDescription =
    firstMatch(html, /<meta[^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i) ||
    firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description|twitter:description)["'][^>]*>/i);
  const articleMatch = firstMatch(html, /<article[^>]*>([\s\S]*?)<\/article>/i);
  const paragraphSource = articleMatch || html;
  const paragraphs = [...paragraphSource.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((match) => htmlToText(match[1]))
    .filter((paragraph) => countWords(paragraph) >= 8)
    .slice(0, 18);

  return normalizeWhitespace([decodeHtml(metaDescription), ...paragraphs].filter(Boolean).join(" "));
}

function htmlToText(html) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6])>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function extractResponseText(data) {
  if (typeof data.output_text === "string") return data.output_text.trim();
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .map((content) => content.text || "")
    .join(" ")
    .trim();
}

function trimToWordWindow(text, wordTarget) {
  const normalized = normalizeWhitespace(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= wordTarget + 20) return ensureSentenceEnd(normalized);
  return ensureSentenceEnd(words.slice(0, wordTarget + 10).join(" "));
}

function fitToWordCount(text, wordTarget) {
  const words = normalizeWhitespace(text).split(/\s+/).filter(Boolean);
  if (words.length >= wordTarget) return ensureSentenceEnd(words.slice(0, wordTarget).join(" "));

  const padding =
    "This additional context is intentionally conservative: it does not add outside claims, but it keeps the brief useful by stating why the item matters, how strong the HN signal is, and what to check next before acting on it.";
  const padded = [...words];
  const paddingWords = padding.split(/\s+/).filter(Boolean);
  let index = 0;

  while (padded.length < wordTarget) {
    padded.push(paddingWords[index % paddingWords.length]);
    index += 1;
  }

  return ensureSentenceEnd(padded.slice(0, wordTarget).join(" "));
}

function countWords(text = "") {
  return normalizeWhitespace(text).split(/\s+/).filter(Boolean).length;
}

function normalizeWhitespace(text = "") {
  return String(text).replace(/\s+/g, " ").trim();
}

function ensureSentenceEnd(text) {
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function renderIssue({ config: cfg, issueDate: date, stories }) {
  const generatedAt = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: cfg.timezone
  }).format(new Date());

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(cfg.publicationName)} | ${escapeHtml(date)}</title>
  <meta name="description" content="${escapeHtml(cfg.dek)}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,500..900,80,1&family=Inter:wght@500;650;800;900&display=swap" rel="stylesheet">
  <style>
${css()}
  </style>
</head>
<body>
  <header class="cover">
    <p class="kicker">Hacker News Front Page / ${escapeHtml(date)}</p>
    <h1>${escapeHtml(cfg.publicationName)}</h1>
    <p class="dek">${escapeHtml(cfg.dek)}</p>
    <div class="cover-meta">
      <span>Top ${stories.length}</span>
      <span>Curated for ${escapeHtml(cfg.readerName)}</span>
      <span>${escapeHtml(generatedAt)}</span>
    </div>
  </header>

  <main>
    ${stories.map((story, index) => renderSpread(story, index)).join("\n")}
  </main>
</body>
</html>
`;
}

function renderSpread(story, index) {
  const theme = THEMES[index % THEMES.length];
  const number = String(index + 1).padStart(2, "0");
  const stat = story.score ? story.score : story.rank;
  const statLabel = story.score ? "HN points" : "front-page rank";
  const tags = story.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("");
  const applies = story.appliesToReader ? `<div class="applies">Directly applies to you</div>` : "";

  return `<article class="spread ${theme}">
    <div class="number" aria-label="Story ${number}">${number}</div>
    <div class="story-main">
      <div class="story-topline">
        <span>${escapeHtml(story.site)}</span>
        <span>Rank ${story.rank}</span>
      </div>
      <h2>${escapeHtml(story.title)}</h2>
      <p class="why">${escapeHtml(story.why)}</p>
      <section class="brief">
        <p class="brief-label">200-word brief / ${story.summaryWordCount} words</p>
        <p>${escapeHtml(story.summary)}</p>
      </section>
      <div class="tags">${tags}</div>
      ${applies}
    </div>
    <aside class="story-aside">
      <p class="stat">${stat}</p>
      <p class="stat-label">${escapeHtml(statLabel)}</p>
      <p>${story.comments} comments</p>
      <p>${escapeHtml(story.age || "fresh")} by ${escapeHtml(story.author || "HN")}</p>
      <a href="${escapeAttribute(story.url)}">Read story</a>
      <a href="${escapeAttribute(story.hnUrl)}">HN thread</a>
    </aside>
  </article>`;
}

function renderIndex({ config: cfg, issueDate: date }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(cfg.publicationName)}</title>
  <meta http-equiv="refresh" content="0; url=./${escapeAttribute(date)}.html">
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4ecd8; color: #17120c; font: 800 28px/1.2 system-ui, sans-serif; }
    a { color: inherit; }
  </style>
</head>
<body>
  <a href="./${escapeAttribute(date)}.html">Open ${escapeHtml(cfg.publicationName)} for ${escapeHtml(date)}</a>
</body>
</html>
`;
}

function css() {
  return `
:root {
  color-scheme: light;
  --ink: #17120c;
  --paper: #f5ecd8;
  --muted: rgba(23, 18, 12, 0.72);
  --rule: rgba(23, 18, 12, 0.2);
}

* { box-sizing: border-box; }

html { scroll-behavior: smooth; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: "Inter", system-ui, sans-serif;
  font-size: clamp(22px, 2vw, 30px);
  line-height: 1.22;
}

a { color: inherit; text-decoration-thickness: 0.12em; text-underline-offset: 0.18em; }

.cover,
.spread {
  min-height: 100vh;
  display: grid;
  gap: clamp(24px, 4vw, 56px);
  padding: clamp(28px, 6vw, 86px);
  overflow: hidden;
}

.cover {
  align-content: space-between;
  background:
    linear-gradient(90deg, rgba(23,18,12,0.08) 1px, transparent 1px),
    linear-gradient(180deg, rgba(23,18,12,0.08) 1px, transparent 1px),
    #f4ecd8;
  background-size: 80px 80px;
}

.kicker,
.story-topline,
.stat-label,
.tags,
.applies,
.cover-meta {
  font-size: clamp(20px, 1.8vw, 28px);
  font-weight: 900;
  text-transform: uppercase;
}

.kicker,
.story-topline,
.stat-label {
  color: var(--muted);
}

h1,
h2,
.number,
.stat {
  font-family: "Fraunces", Georgia, serif;
  letter-spacing: 0;
}

h1 {
  max-width: 10ch;
  margin: 0;
  font-size: clamp(82px, 16vw, 230px);
  line-height: 0.82;
}

.dek {
  max-width: 980px;
  margin: 0;
  font-size: clamp(30px, 5vw, 72px);
  font-weight: 800;
  line-height: 1.02;
}

.cover-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  border-top: 5px solid currentColor;
  padding-top: 22px;
}

.cover-meta span {
  border: 3px solid currentColor;
  padding: 10px 14px;
}

.spread {
  position: relative;
  grid-template-columns: minmax(0, 1.4fr) minmax(280px, 0.55fr);
  align-items: center;
  border-top: 8px solid rgba(0, 0, 0, 0.18);
}

.number {
  position: absolute;
  line-height: 0.76;
  pointer-events: none;
  user-select: none;
}

.story-main {
  position: relative;
  z-index: 1;
}

.story-topline {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 22px;
}

h2 {
  max-width: 12ch;
  margin: 0;
  font-size: clamp(54px, 9vw, 140px);
  line-height: 0.88;
}

.why {
  max-width: 900px;
  margin: 30px 0 0;
  font-size: clamp(28px, 3vw, 48px);
  font-weight: 800;
}

.brief {
  max-width: 980px;
  margin-top: 28px;
  border-top: 5px solid currentColor;
  padding-top: 18px;
}

.brief p {
  margin: 0;
}

.brief p:last-child {
  font-size: clamp(24px, 2.4vw, 36px);
  font-weight: 800;
  line-height: 1.18;
}

.brief-label {
  margin-bottom: 10px !important;
  color: var(--muted);
  font-size: clamp(18px, 1.5vw, 24px);
  font-weight: 900;
  text-transform: uppercase;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-top: 28px;
}

.tags span,
.applies {
  border: 4px solid currentColor;
  padding: 10px 14px;
}

.applies {
  display: inline-block;
  margin-top: 18px;
  background: #ffef5a;
  color: #17120c;
  transform: rotate(-2deg);
}

.story-aside {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 16px;
  align-content: center;
  border-left: 5px solid currentColor;
  padding-left: clamp(22px, 3vw, 44px);
  font-weight: 900;
}

.story-aside p {
  margin: 0;
  font-size: clamp(24px, 2.2vw, 38px);
}

.story-aside a {
  display: inline-block;
  width: fit-content;
  margin-top: 8px;
  font-size: clamp(24px, 2.4vw, 40px);
}

.stat {
  margin: 0;
  font-size: clamp(84px, 11vw, 190px);
  line-height: 0.78;
}

.hero {
  background: #f6c744;
}

.hero .number {
  right: -2vw;
  top: -3vw;
  font-size: clamp(180px, 36vw, 520px);
  opacity: 0.28;
}

.midnight {
  --ink: #f3efe1;
  --muted: rgba(243, 239, 225, 0.72);
  background: #101624;
  color: var(--ink);
}

.midnight .number {
  left: 3vw;
  bottom: -4vw;
  font-size: clamp(160px, 32vw, 460px);
  color: #66e0c2;
}

.rose-alert-stamp {
  background: #ffd5dc;
}

.rose-alert-stamp .number {
  right: 6vw;
  top: 8vw;
  border: 8px solid currentColor;
  border-radius: 50%;
  padding: 0.16em;
  font-size: clamp(110px, 18vw, 260px);
  transform: rotate(12deg);
}

.terminal {
  --ink: #d8ffd1;
  --muted: rgba(216, 255, 209, 0.75);
  background: #062015;
  color: var(--ink);
  font-family: "Inter", ui-monospace, monospace;
}

.terminal h2::before {
  content: "> ";
  color: #4cff7f;
}

.terminal .number {
  right: 4vw;
  bottom: 4vw;
  font-size: clamp(120px, 24vw, 350px);
  color: rgba(76, 255, 127, 0.28);
}

.academic-drop-cap {
  background: #efe7d6;
}

.academic-drop-cap h2::first-letter {
  float: left;
  font-size: 1.9em;
  line-height: 0.68;
  padding-right: 0.08em;
}

.academic-drop-cap .number {
  left: 4vw;
  top: 3vw;
  font-size: clamp(130px, 25vw, 360px);
  opacity: 0.12;
}

.blueprint {
  --ink: #f7f0dc;
  --muted: rgba(247, 240, 220, 0.74);
  color: var(--ink);
  background:
    linear-gradient(rgba(247,240,220,0.12) 2px, transparent 2px),
    linear-gradient(90deg, rgba(247,240,220,0.12) 2px, transparent 2px),
    #173d6f;
  background-size: 48px 48px;
}

.blueprint .number {
  right: -1vw;
  top: 5vw;
  font-size: clamp(150px, 27vw, 390px);
  -webkit-text-stroke: 4px currentColor;
  color: transparent;
}

.health-note {
  background: #cbe9d8;
}

.health-note .number {
  left: 50%;
  top: 50%;
  font-size: clamp(180px, 35vw, 500px);
  transform: translate(-50%, -50%) rotate(-8deg);
  color: rgba(23, 18, 12, 0.11);
}

.finance-ledger {
  background: #d9e7ff;
}

.finance-ledger .number {
  left: 2vw;
  bottom: -2vw;
  font-size: clamp(150px, 30vw, 430px);
  font-variant-numeric: tabular-nums;
}

.finance-ledger .story-aside {
  border-left-style: double;
  border-left-width: 12px;
}

.weird-lab {
  background: #e7ddff;
}

.weird-lab .number {
  right: 3vw;
  top: 3vw;
  font-size: clamp(110px, 20vw, 300px);
  filter: blur(0.3px);
  transform: skew(-8deg);
}

.big-stat-finish {
  background: #ff7f50;
}

.big-stat-finish .number {
  inset: auto 0 -4vw auto;
  font-size: clamp(210px, 40vw, 560px);
  opacity: 0.2;
}

.big-stat-finish .stat {
  font-size: clamp(110px, 16vw, 240px);
}

@media (max-width: 860px) {
  .cover,
  .spread {
    min-height: auto;
    padding: 30px 22px 42px;
  }

  .cover {
    min-height: 100svh;
  }

  .spread {
    grid-template-columns: 1fr;
    align-items: start;
  }

  .story-aside {
    border-left: 0;
    border-top: 5px solid currentColor;
    padding-left: 0;
    padding-top: 22px;
  }

  h2 {
    max-width: 11ch;
  }
}
`;
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

function absolutizeUrl(rawUrl) {
  if (rawUrl.startsWith("item?id=")) return `${HN_URL}${rawUrl}`;
  if (rawUrl.startsWith("/")) return `https://news.ycombinator.com${rawUrl}`;
  try {
    return new URL(rawUrl, HN_URL).href;
  } catch {
    return rawUrl;
  }
}

function firstMatch(text, pattern) {
  return text.match(pattern)?.[1] || "";
}

function decodeHtml(value = "") {
  const entities = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };

  return value
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity) => {
      if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      return entities[entity.toLowerCase()] || `&${entity};`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value = "") {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
