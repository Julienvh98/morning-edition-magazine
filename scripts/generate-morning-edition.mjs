import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const configPath = path.join(root, "config", "morning-edition.json");
const outputDir = path.join(root, "magazines");
const dataDir = path.join(root, "data");
const officialNewsStatePath = path.join(dataDir, "official-news-seen.json");

const HN_URL = "https://news.ycombinator.com/";
const ITEM_URL = "https://news.ycombinator.com/item?id=";
const BROWSER_HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
  "accept-language": "en-US,en;q=0.9",
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
};
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
await mkdir(dataDir, { recursive: true });

const frontPage = await fetchHackerNewsFrontPage();
const curated = curateStories(frontPage, config).slice(0, 10);

if (curated.length === 0) {
  throw new Error("No Hacker News stories were parsed from the front page.");
}

const stories = await enrichStoriesWithSummaries(curated, config);
const officialNewsState = await loadOfficialNewsState();
const officialNews = await fetchOfficialNews({ cfg: config, issueDate, state: officialNewsState });

const html = stripTrailingWhitespace(renderIssue({ config, issueDate, stories, officialNews }));
const outputPath = path.join(outputDir, `${issueDate}.html`);
await writeFile(outputPath, html, "utf8");
await writeFile(path.join(outputDir, "index.html"), stripTrailingWhitespace(renderIndex({ config, issueDate })), "utf8");
markOfficialNewsSeen({ state: officialNewsState, items: officialNews.items, issueDate });
await writeFile(officialNewsStatePath, `${JSON.stringify(officialNewsState, null, 2)}\n`, "utf8");

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

async function loadOfficialNewsState() {
  try {
    const state = JSON.parse(await readFile(officialNewsStatePath, "utf8"));
    return {
      seen: state.seen && typeof state.seen === "object" ? state.seen : {},
      lastRun: state.lastRun || null
    };
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.warn(`Could not read official news state: ${error.message}`);
    }
    return { seen: {}, lastRun: null };
  }
}

async function fetchOfficialNews({ cfg, issueDate, state }) {
  const officialCfg = cfg.officialNews || {};
  const lookbackDays = Number(officialCfg.lookbackDays || 2);
  const sinceDate = subtractDays(issueDate, lookbackDays);
  const sources = officialCfg.sources || defaultOfficialNewsSources();
  const sourceErrors = [];
  const candidates = [];

  for (const source of sources) {
    try {
      const sourceItems = await fetchOfficialNewsSource(source);
      candidates.push(
        ...sourceItems.filter(
          (item) =>
            item.publishedDate >= sinceDate &&
            item.publishedDate <= issueDate &&
            (!state.seen[item.url] || state.seen[item.url].firstIncluded === issueDate)
        )
      );
    } catch (error) {
      sourceErrors.push(`${source.label || source.id}: ${error.message}`);
      console.warn(`Could not fetch official news from ${source.label || source.id}: ${error.message}`);
    }
  }

  const deduped = dedupeBy(candidates, (item) => item.url).sort((a, b) => {
    if (a.publishedDate !== b.publishedDate) return b.publishedDate.localeCompare(a.publishedDate);
    return a.sourceLabel.localeCompare(b.sourceLabel) || a.title.localeCompare(b.title);
  });

  const items = [];
  for (const item of deduped) {
    const sourceText = await fetchOfficialArticleText(item).catch((error) => {
      console.warn(`Could not fetch official article text for ${item.url}: ${error.message}`);
      return item.description || "";
    });
    const summary = await summarizeOfficialArticle({ article: item, sourceText, cfg }).catch((error) => {
      console.warn(`Could not summarize official article ${item.url}: ${error.message}`);
      return fallbackOfficialSummary({ article: item, sourceText, cfg });
    });

    items.push({
      ...item,
      sourceText,
      summary,
      summaryWordCount: countWords(summary)
    });
  }

  return { items, sourceErrors, sinceDate };
}

function defaultOfficialNewsSources() {
  return [
    {
      id: "anthropic",
      label: "Anthropic",
      listingUrl: "https://www.anthropic.com/news",
      baseUrl: "https://www.anthropic.com"
    },
    {
      id: "openai",
      label: "OpenAI",
      listingUrl: "https://openai.com/news/company-announcements/",
      rssUrl: "https://openai.com/news/rss.xml",
      baseUrl: "https://openai.com",
      categories: ["Company", "Global Affairs"]
    }
  ];
}

async function fetchOfficialNewsSource(source) {
  if (source.id === "anthropic") return fetchAnthropicNews(source);
  if (source.id === "openai") return fetchOpenAINews(source);
  return [];
}

async function fetchAnthropicNews(source) {
  const html = await fetchText(source.listingUrl);
  const items = [];

  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    const text = normalizeWhitespace(htmlToText(match[2]));
    const dateInfo = parseNewsDate(text);
    if (!href || !dateInfo || !text) continue;

    const url = new URL(href, source.baseUrl).href;
    if (!new URL(url).hostname.endsWith("anthropic.com")) continue;

    const category = parseNewsCategory(text, dateInfo.label) || "News";
    const title = cleanNewsTitle(text, dateInfo.label, category);
    if (!title || title.length < 4) continue;

    items.push({
      sourceId: source.id,
      sourceLabel: source.label,
      category,
      title,
      url,
      publishedDate: dateInfo.iso,
      description: ""
    });
  }

  return dedupeBy(items, (item) => item.url);
}

async function fetchOpenAINews(source) {
  const listingItems = await fetchOpenAIListingNews(source).catch((error) => {
    console.warn(`Could not read OpenAI listing page, falling back to RSS: ${error.message}`);
    return [];
  });
  const rssItems = await fetchOpenAINewsRss(source).catch((error) => {
    if (!listingItems.length) throw error;
    console.warn(`Could not read OpenAI RSS backup: ${error.message}`);
    return [];
  });

  return dedupeBy([...listingItems, ...rssItems], (item) => item.url);
}

async function fetchOpenAIListingNews(source) {
  const html = await fetchText(source.listingUrl);
  const allowedCategories = new Set(source.categories || ["Company", "Global Affairs"]);
  const items = [];

  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeHtml(match[1]);
    const text = normalizeWhitespace(htmlToText(match[2]));
    const dateInfo = parseNewsDate(text);
    if (!href || !dateInfo || !text) continue;

    const category = parseNewsCategory(text, dateInfo.label);
    if (allowedCategories.size && !allowedCategories.has(category)) continue;

    const url = new URL(href, source.baseUrl).href;
    if (!new URL(url).hostname.endsWith("openai.com")) continue;

    const title = cleanNewsTitle(text, dateInfo.label, category);
    if (!title || title.length < 4) continue;

    items.push({
      sourceId: source.id,
      sourceLabel: source.label,
      category: category || "Company",
      title,
      url,
      publishedDate: dateInfo.iso,
      description: ""
    });
  }

  return dedupeBy(items, (item) => item.url);
}

async function fetchOpenAINewsRss(source) {
  const xml = await fetchText(source.rssUrl || "https://openai.com/news/rss.xml", {
    accept: "application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
  });
  const allowedCategories = new Set(source.categories || ["Company", "Global Affairs"]);
  const items = [];

  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const block = match[1];
    const category = xmlTag(block, "category");
    if (allowedCategories.size && !allowedCategories.has(category)) continue;

    const pubDate = new Date(xmlTag(block, "pubDate"));
    if (Number.isNaN(pubDate.getTime())) continue;

    const title = xmlTag(block, "title");
    const url = xmlTag(block, "link");
    if (!title || !url) continue;

    items.push({
      sourceId: source.id,
      sourceLabel: source.label,
      category: category || "Company",
      title,
      url,
      publishedDate: pubDate.toISOString().slice(0, 10),
      description: xmlTag(block, "description")
    });
  }

  return dedupeBy(items, (item) => item.url);
}

async function fetchOfficialArticleText(article) {
  const text = await fetchStoryText({
    title: article.title,
    url: article.url,
    site: article.sourceLabel,
    rank: 0,
    score: 0,
    comments: 0,
    why: `official ${article.sourceLabel} ${article.category} article published ${article.publishedDate}`
  });

  return normalizeWhitespace([article.description, text].filter(Boolean).join(" ")).slice(0, 12000);
}

async function summarizeOfficialArticle({ article, sourceText, cfg }) {
  if (!process.env.OPENAI_API_KEY || !sourceText || countWords(sourceText) < 80) {
    return fallbackOfficialSummary({ article, sourceText, cfg });
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
        "You write concise editorial briefs for a personal morning edition. Use only the official article text and metadata provided. " +
        "Do not invent facts, do not mention missing context, and do not say that text was provided. " +
        `Write one self-contained summary of exactly ${wordTarget} words.`,
      input:
        `Title: ${article.title}\n` +
        `Source: ${article.sourceLabel}\n` +
        `Category: ${article.category}\n` +
        `Published: ${article.publishedDate}\n` +
        `Official link: ${article.url}\n\n` +
        `Official article text:\n${sourceText.slice(0, 10000)}`
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI responded with ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = extractResponseText(data);
  if (!text) throw new Error("OpenAI response did not include output text");
  return fitToWordCount(text, wordTarget);
}

function fallbackOfficialSummary({ article, sourceText, cfg }) {
  const wordTarget = Number(cfg.summaryWordTarget || 200);
  const text = normalizeWhitespace(sourceText || article.description || "");
  const fallback = [
    text,
    `${article.title} is an official ${article.sourceLabel} ${article.category} update published on ${article.publishedDate}.`,
    "The item is included at the top of the Morning Edition because it is a direct first-party update from a major AI lab.",
    "Use the official link to read the complete announcement, then compare the claim against product documentation, customer examples, technical details, and timing before acting on it.",
    "For your morning scan, the practical question is whether this changes tool choices, enterprise AI workflows, developer roadmaps, finance use cases, or the competitive picture around applied AI."
  ]
    .filter(Boolean)
    .join(" ");

  return fitToWordCount(fallback, wordTarget);
}

function markOfficialNewsSeen({ state, items, issueDate }) {
  state.lastRun = issueDate;
  for (const item of items) {
    state.seen[item.url] = {
      source: item.sourceLabel,
      title: item.title,
      category: item.category,
      publishedDate: item.publishedDate,
      firstIncluded: issueDate
    };
  }
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
        ...BROWSER_HEADERS,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8"
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

function stripTrailingWhitespace(text = "") {
  return String(text).replace(/[ \t]+$/gm, "");
}

function ensureSentenceEnd(text) {
  if (!text) return "";
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function renderIssue({ config: cfg, issueDate: date, stories, officialNews }) {
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
  <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght,SOFT,WONK@9..144,500..900,80,1&family=IBM+Plex+Serif:wght@400;500&family=Inter:wght@500;650;800;900&display=swap" rel="stylesheet">
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

  ${renderOfficialNews(officialNews)}

  <main>
    ${stories.map((story, index) => renderSpread(story, index)).join("\n")}
  </main>
</body>
</html>
`;
}

function renderOfficialNews(officialNews) {
  const items = officialNews?.items || [];
  const sourceErrors = officialNews?.sourceErrors || [];
  const sinceDate = officialNews?.sinceDate || "";

  if (!items.length) {
    const errorNote = sourceErrors.length
      ? ` Source check warnings: ${sourceErrors.join("; ")}.`
      : " No new official Anthropic or OpenAI company updates were found for this issue.";
    return `<section class="official-news">
    <div class="official-news-header">
      <p class="kicker">Official AI Lab News</p>
      <h2>Anthropic + OpenAI</h2>
      <p>Checked first-party news sources since ${escapeHtml(sinceDate)}.${escapeHtml(errorNote)}</p>
    </div>
  </section>`;
  }

  return `<section class="official-news">
    <div class="official-news-header">
      <p class="kicker">Official AI Lab News</p>
      <h2>Anthropic + OpenAI</h2>
      <p>New first-party updates since ${escapeHtml(sinceDate)}, including any missed articles from the previous run.</p>
    </div>
    <div class="official-news-grid">
      ${items.map((item, index) => renderOfficialNewsCard(item, index)).join("\n")}
    </div>
  </section>`;
}

function renderOfficialNewsCard(item, index) {
  const number = String(index + 1).padStart(2, "0");

  return `<article class="official-news-card">
    <div class="official-news-num">${number}</div>
    <div>
      <p class="official-news-meta">${escapeHtml(item.sourceLabel)} / ${escapeHtml(item.category)} / ${escapeHtml(item.publishedDate)}</p>
      <h3>${escapeHtml(item.title)}</h3>
      <p class="official-news-summary">${escapeHtml(item.summary)}</p>
      <p class="official-news-count">200-word brief / ${item.summaryWordCount} words</p>
      <a href="${escapeAttribute(item.url)}">Read official article</a>
    </div>
  </article>`;
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

.official-news {
  min-height: 100vh;
  display: grid;
  align-content: start;
  gap: clamp(28px, 4vw, 54px);
  padding: clamp(28px, 6vw, 86px);
  background: #f7f0df;
  border-top: 8px solid rgba(23, 18, 12, 0.28);
  border-bottom: 8px solid rgba(23, 18, 12, 0.18);
}

.official-news-header {
  display: grid;
  gap: 18px;
  border-bottom: 2px solid rgba(23, 18, 12, 0.35);
  padding-bottom: 24px;
}

.official-news-header h2 {
  max-width: 10ch;
  margin: 0;
  font-size: clamp(56px, 10vw, 152px);
}

.official-news-header p:last-child {
  max-width: 960px;
  margin: 0;
  color: rgba(23, 18, 12, 0.72);
  font-family: "IBM Plex Serif", Georgia, serif;
  font-size: clamp(20px, 1.9vw, 30px);
  font-weight: 400;
  line-height: 1.32;
}

.official-news-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 420px), 1fr));
  gap: clamp(20px, 3vw, 36px);
}

.official-news-card {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 18px;
  border-top: 2px solid rgba(23, 18, 12, 0.32);
  padding-top: 18px;
}

.official-news-num {
  font-family: "Fraunces", Georgia, serif;
  font-size: clamp(44px, 5vw, 74px);
  font-weight: 800;
  line-height: 0.9;
}

.official-news-meta,
.official-news-count {
  margin: 0;
  color: rgba(23, 18, 12, 0.58);
  font-size: clamp(14px, 1vw, 16px);
  font-weight: 800;
  text-transform: uppercase;
}

.official-news-card h3 {
  margin: 8px 0 16px;
  font-family: "Fraunces", Georgia, serif;
  font-size: clamp(32px, 4vw, 56px);
  font-weight: 760;
  line-height: 0.96;
}

.official-news-summary {
  margin: 0 0 16px;
  color: rgba(23, 18, 12, 0.82);
  font-family: "IBM Plex Serif", Georgia, serif;
  font-size: clamp(18px, 1.45vw, 23px);
  font-weight: 400;
  line-height: 1.36;
}

.official-news-card a {
  display: inline-block;
  margin-top: 14px;
  color: rgba(23, 18, 12, 0.8);
  font-size: clamp(15px, 1.1vw, 18px);
  font-weight: 900;
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
  border-top: 2px solid rgba(23, 18, 12, 0.28);
  padding-top: 18px;
}

.brief p {
  margin: 0;
}

.brief p:last-child {
  color: rgba(23, 18, 12, 0.82);
  font-family: "IBM Plex Serif", Georgia, serif;
  font-size: clamp(19px, 1.55vw, 25px);
  font-weight: 400;
  line-height: 1.36;
}

.brief-label {
  margin-bottom: 10px !important;
  color: var(--muted);
  font-size: clamp(15px, 1.15vw, 19px);
  font-weight: 900;
  text-transform: uppercase;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
}

.tags span {
  color: rgba(23, 18, 12, 0.58);
  border: 1px solid rgba(23, 18, 12, 0.28);
  padding: 4px 7px;
  font-size: clamp(13px, 1vw, 15px);
  font-weight: 800;
}

.applies {
  display: inline-block;
  margin-top: 18px;
  border: 2px solid currentColor;
  padding: 7px 10px;
  background: #ffef5a;
  color: #17120c;
  font-size: clamp(14px, 1.1vw, 17px);
  font-weight: 900;
  transform: rotate(-2deg);
}

.story-aside {
  position: relative;
  z-index: 1;
  display: grid;
  gap: 6px;
  align-content: center;
  border-left: 1px solid rgba(23, 18, 12, 0.28);
  padding-left: clamp(22px, 3vw, 44px);
}

.story-aside p {
  color: rgba(23, 18, 12, 0.62);
  margin: 0;
  font-size: clamp(14px, 1.1vw, 17px);
  font-weight: 800;
}

.story-aside a {
  display: inline-block;
  width: fit-content;
  margin-top: 8px;
  color: rgba(23, 18, 12, 0.78);
  font-size: clamp(15px, 1.2vw, 18px);
  font-weight: 900;
}

.stat {
  margin: 0;
  font-family: "Inter", system-ui, sans-serif;
  font-size: clamp(22px, 1.8vw, 28px);
  font-weight: 900;
  line-height: 1.05;
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
  .spread,
  .official-news {
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

  .official-news-card {
    grid-template-columns: 1fr;
  }
}
`;
}

async function fetchText(url, headers = {}) {
  const response = await fetch(url, {
    headers: {
      ...BROWSER_HEADERS,
      ...headers
    }
  });

  if (!response.ok) {
    throw new Error(`${url} responded with ${response.status}`);
  }

  return response.text();
}

function parseNewsDate(text) {
  const label = firstMatch(
    text,
    /\b((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Sept|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},\s+\d{4})\b/i
  );
  if (!label) return null;

  const date = new Date(`${label} 00:00:00 UTC`);
  if (Number.isNaN(date.getTime())) return null;

  return {
    label,
    iso: date.toISOString().slice(0, 10)
  };
}

function parseNewsCategory(text, dateLabel) {
  const afterDate = normalizeWhitespace(text.replace(dateLabel, " "));
  return (
    firstMatch(afterDate, /^(Announcements|Product|Research|Company|Safety|Engineering|Security|Global Affairs|AI Adoption|Publication)\b/i) ||
    firstMatch(afterDate, /\b(Announcements|Product|Research|Company|Safety|Engineering|Security|Global Affairs|AI Adoption|Publication)$/i)
  );
}

function cleanNewsTitle(text, dateLabel, category) {
  let title = normalizeWhitespace(text.replace(dateLabel, " "));
  if (category) {
    title = normalizeWhitespace(title.replace(new RegExp(`^${escapeRegExp(category)}\\b`, "i"), " "));
    title = normalizeWhitespace(title.replace(new RegExp(`\\b${escapeRegExp(category)}\\b$`, "i"), " "));
  }
  return decodeHtml(title);
}

function xmlTag(block, tagName) {
  const raw = firstMatch(block, new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return decodeHtml(raw.replace(/^<!\[CDATA\[|\]\]>$/g, ""));
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function subtractDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
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

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
