import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const config = JSON.parse(await readFile(path.join(root, "config", "tldr-ai-edition.json"), "utf8"));

const sourcePath = path.resolve(root, process.env.TLDR_AI_SOURCE || config.sourcePath);
const outputDir = path.resolve(root, process.env.TLDR_AI_OUTPUT_DIR || config.outputDir);
const source = await readFile(sourcePath, "utf8");
const issue = parseTldrAi(source, config);

await mkdir(outputDir, { recursive: true });

const fileName = `${issue.date}.html`;
const outputPath = path.join(outputDir, fileName);
const variants = config.variants?.length ? config.variants : [{ id: "broadsheet", label: "Broadsheet" }];
const defaultVariant = variants.find((variant) => variant.id === config.defaultVariant) || variants[0];

for (const variant of variants) {
  await writeFile(path.join(outputDir, `${issue.date}-${variant.id}.html`), renderIssue(issue, config, variant), "utf8");
}

await writeFile(outputPath, renderIssue(issue, config, defaultVariant), "utf8");
await writeFile(path.join(outputDir, "index.html"), renderIndex(issue, config), "utf8");

console.log(`Wrote ${path.relative(root, outputPath)}`);

function parseTldrAi(markdown, cfg) {
  const lines = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim());

  const subject = firstNonEmpty(lines) || cfg.publicationName;
  const date =
    lines
      .map((line) => line.match(/^TLDR AI\s+(\d{4}-\d{2}-\d{2})$/)?.[1])
      .find(Boolean) || formatDateInZone(new Date(), cfg.timezone);

  const sections = [];
  let current = null;
  let currentArticle = null;
  let skippingSponsor = false;
  const sectionNames = new Set(cfg.sectionOrder);

  for (const line of lines) {
    if (!line) continue;
    if (cfg.footerStopPhrases.some((phrase) => line.startsWith(phrase))) break;
    if (isDivider(line)) continue;

    if (sectionNames.has(line)) {
      pushArticle(current, currentArticle);
      currentArticle = null;
      current = { title: line, articles: [] };
      sections.push(current);
      skippingSponsor = false;
      continue;
    }

    if (!current) continue;

    const link = parseMarkdownLink(line);
    if (link) {
      pushArticle(current, currentArticle);
      currentArticle = null;
      skippingSponsor = /\(sponsor\)/i.test(link.title);

      if (!skippingSponsor) {
        currentArticle = {
          title: cleanTitle(link.title),
          url: decodeTrackingUrl(link.url),
          meta: extractMeta(link.title),
          summary: []
        };
      }

      continue;
    }

    if (!skippingSponsor && currentArticle) {
      currentArticle.summary.push(line);
    }
  }

  pushArticle(current, currentArticle);

  const filteredSections = sections
    .map((section) => ({ ...section, articles: section.articles.filter((article) => article.title && article.summary.length) }))
    .filter((section) => section.articles.length);

  return {
    subject,
    date,
    sections: filteredSections,
    totalArticles: filteredSections.reduce((sum, section) => sum + section.articles.length, 0)
  };
}

function pushArticle(section, article) {
  if (!section || !article) return;
  section.articles.push({
    ...article,
    summary: article.summary.join(" ").replace(/\s+/g, " ").trim()
  });
}

function parseMarkdownLink(line) {
  const match = line.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!match) return null;
  return { title: match[1], url: match[2] };
}

function cleanTitle(title) {
  return title.replace(/\s*\((?:\d+\s+minute read|GitHub Repo)\)\s*$/i, "").trim();
}

function extractMeta(title) {
  return title.match(/\((\d+\s+minute read|GitHub Repo)\)\s*$/i)?.[1] || "";
}

function decodeTrackingUrl(url) {
  try {
    const match = url.match(/https:%2F%2F([^/]+)/i);
    if (!match) return url;
    const encoded = url.match(/CL0\/([^/]+)/)?.[1];
    if (!encoded) return url;
    return decodeURIComponent(encoded);
  } catch {
    return url;
  }
}

function isDivider(line) {
  return !/[A-Za-z0-9]/.test(line) && line.length <= 8;
}

function firstNonEmpty(lines) {
  return lines.find((line) => line && !line.startsWith("[") && line !== "TLDR") || "";
}

function renderIssue(issue, cfg, variant) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(cfg.publicationName)} | ${escapeHtml(issue.date)} | ${escapeHtml(variant.label)}</title>
  <style>
${css()}
  </style>
</head>
<body class="variant-${escapeAttribute(variant.id)}">
  <header class="masthead">
    <div>
      <p class="eyebrow">Personal edition / sponsors removed / ${escapeHtml(variant.label)}</p>
      <h1>${escapeHtml(cfg.publicationName)}</h1>
    </div>
    <div class="issue-meta">
      <span>${escapeHtml(issue.date)}</span>
      <span>${issue.totalArticles} articles</span>
      <span>Source: TLDR AI email</span>
    </div>
  </header>

  <nav class="variant-nav" aria-label="Reader versions">
    ${cfg.variants.map((item) => `<a ${item.id === variant.id ? "aria-current=\"page\"" : ""} href="./${escapeAttribute(issue.date)}-${escapeAttribute(item.id)}.html">${escapeHtml(item.label)}</a>`).join("\n    ")}
  </nav>

  <main>
    ${issue.sections.map((section, index) => renderSection(section, index)).join("\n")}
  </main>
</body>
</html>
`;
}

function renderSection(section, index) {
  const lead = section.articles[0];
  const rest = section.articles.slice(1);
  const sectionNumber = String(index + 1).padStart(2, "0");

  return `<section class="section section-${index + 1}">
    <div class="section-rule">
      <span>${sectionNumber}</span>
      <h2>${escapeHtml(section.title)}</h2>
    </div>
    <article class="lead-story">
      <div class="lead-number">${sectionNumber}</div>
      <div>
        <p class="meta">${escapeHtml(lead.meta || "TLDR AI")}</p>
        <h3><a href="${escapeAttribute(lead.url)}">${escapeHtml(lead.title)}</a></h3>
        <p>${escapeHtml(lead.summary)}</p>
      </div>
    </article>
    <div class="article-grid">
      ${rest.map((article) => renderArticle(article)).join("\n")}
    </div>
  </section>`;
}

function renderArticle(article) {
  return `<article class="article-card">
    <p class="meta">${escapeHtml(article.meta || "TLDR AI")}</p>
    <h4><a href="${escapeAttribute(article.url)}">${escapeHtml(article.title)}</a></h4>
    <p>${escapeHtml(article.summary)}</p>
  </article>`;
}

function renderIndex(issue, cfg) {
  const defaultVariant = cfg.variants?.find((variant) => variant.id === cfg.defaultVariant) || cfg.variants?.[0];
  const target = defaultVariant ? `${issue.date}-${defaultVariant.id}.html` : `${issue.date}.html`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="0; url=./${escapeAttribute(target)}">
  <title>${escapeHtml(cfg.publicationName)}</title>
</head>
<body>
  <a href="./${escapeAttribute(target)}">Open ${escapeHtml(cfg.publicationName)} for ${escapeHtml(issue.date)}</a>
</body>
</html>
`;
}

function css() {
  return `
:root {
  --ft-paper: #fff1da;
  --ft-paper-deep: #f3dfbd;
  --ink: #262019;
  --muted: #6b5c4a;
  --rule: #262019;
  --accent: #b1282e;
  --font-display: "FinancierDisplayWeb", "Financier Display", "Financier", Georgia, serif;
  --font-text: "FinancierTextWeb", "Financier Text", Georgia, serif;
  --font-sans: "MetricWeb", "Metric", Arial, sans-serif;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--ft-paper);
  color: var(--ink);
  font-family: var(--font-sans);
  font-size: 1.35rem;
  line-height: 1.32;
}

a {
  color: inherit;
  text-decoration-color: rgba(177, 40, 46, 0.65);
  text-decoration-thickness: 0.08em;
  text-underline-offset: 0.16em;
}

.masthead {
  display: grid;
  grid-template-columns: 1fr minmax(280px, 0.42fr);
  gap: clamp(24px, 5vw, 72px);
  align-items: end;
  padding: clamp(28px, 6vw, 84px);
  border-bottom: 10px double var(--rule);
  background: linear-gradient(180deg, #fff6e7 0%, var(--ft-paper) 74%);
}

.eyebrow,
.meta,
.issue-meta,
.section-rule span {
  margin: 0;
  color: var(--muted);
  font-size: 1.05rem;
  font-weight: 900;
  text-transform: uppercase;
}

h1,
h2,
h3,
h4,
.lead-number {
  font-family: var(--font-display);
  letter-spacing: 0;
}

h1 {
  margin: 10px 0 0;
  font-size: 8.4rem;
  line-height: 0.84;
}

.issue-meta {
  display: grid;
  gap: 12px;
  justify-items: end;
  text-align: right;
}

.issue-meta span {
  border-top: 3px solid var(--rule);
  padding-top: 10px;
  width: min(100%, 360px);
}

.variant-nav {
  position: sticky;
  top: 0;
  z-index: 4;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  padding: 12px clamp(22px, 6vw, 84px);
  border-bottom: 2px solid var(--rule);
  background: rgba(255, 241, 218, 0.96);
  font-family: var(--font-sans);
  font-size: 1rem;
  font-weight: 900;
  text-transform: uppercase;
}

.variant-nav a {
  border: 2px solid var(--rule);
  padding: 7px 10px;
  text-decoration: none;
}

.variant-nav a[aria-current="page"] {
  background: var(--rule);
  color: var(--ft-paper);
}

.section {
  padding: clamp(30px, 5vw, 78px) clamp(22px, 6vw, 84px);
  border-bottom: 4px solid var(--rule);
}

.section:nth-child(even) {
  background: var(--ft-paper-deep);
}

.section-rule {
  display: grid;
  grid-template-columns: minmax(54px, 92px) 1fr;
  gap: 18px;
  align-items: baseline;
  border-bottom: 5px solid var(--rule);
  margin-bottom: clamp(24px, 4vw, 56px);
  padding-bottom: 14px;
}

h2 {
  margin: 0;
  font-size: 5.2rem;
  line-height: 0.9;
}

.lead-story {
  display: grid;
  grid-template-columns: minmax(96px, 0.34fr) 1fr;
  gap: clamp(20px, 4vw, 64px);
  align-items: start;
  margin-bottom: clamp(26px, 4vw, 56px);
}

.lead-number {
  color: var(--accent);
  font-size: 10rem;
  line-height: 0.78;
  border-right: 4px solid var(--rule);
}

h3,
h4 {
  margin: 8px 0 14px;
  line-height: 0.96;
}

h3 {
  max-width: 13ch;
  font-size: 5.6rem;
}

h4 {
  font-size: 2.7rem;
}

.lead-story p,
.article-card p {
  max-width: 980px;
  margin: 0;
  font-family: var(--font-text);
  font-weight: 650;
}

.article-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: clamp(22px, 3vw, 42px);
}

.article-card {
  border-top: 4px solid var(--rule);
  padding-top: 18px;
}

.article-card p:last-child {
  font-size: 1.22rem;
}

.section-1 .lead-story {
  grid-template-columns: minmax(120px, 0.45fr) 1fr;
}

.section-1 h3 {
  max-width: 11ch;
}

.section-3 .article-grid,
.section-5 .article-grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.variant-markets {
  --ft-paper: #07110f;
  --ft-paper-deep: #0d1d1a;
  --ink: #e8fff5;
  --muted: #86a99c;
  --rule: #9fffd0;
  --accent: #f5d547;
  background:
    radial-gradient(circle at 12% 0%, rgba(159, 255, 208, 0.15), transparent 28rem),
    linear-gradient(180deg, #07110f 0%, #0d1715 100%);
  color: var(--ink);
}

.variant-markets .masthead {
  grid-template-columns: minmax(0, 1fr) minmax(360px, 0.38fr);
  min-height: 48vh;
  align-content: space-between;
  background:
    linear-gradient(90deg, rgba(159, 255, 208, 0.12) 1px, transparent 1px),
    linear-gradient(180deg, rgba(159, 255, 208, 0.12) 1px, transparent 1px),
    #07110f;
  background-size: 34px 34px;
  border-bottom: 4px solid var(--rule);
}

.variant-markets h1 {
  max-width: 10ch;
  font-family: var(--font-sans);
  font-size: 5.8rem;
  font-weight: 900;
  text-transform: uppercase;
}

.variant-markets .issue-meta {
  grid-template-columns: 1fr;
  justify-items: stretch;
  text-align: left;
}

.variant-markets .issue-meta span {
  border: 1px solid rgba(159, 255, 208, 0.5);
  padding: 12px;
  width: 100%;
  color: var(--rule);
  background: rgba(159, 255, 208, 0.06);
}

.variant-markets .variant-nav {
  background: rgba(7, 17, 15, 0.96);
  border-bottom-color: var(--rule);
}

.variant-markets .variant-nav a {
  border-color: rgba(159, 255, 208, 0.55);
}

.variant-markets .variant-nav a[aria-current="page"] {
  background: var(--accent);
  color: #07110f;
}

.variant-markets .section {
  padding-block: 30px;
  border-bottom: 1px solid rgba(159, 255, 208, 0.36);
  background: transparent;
}

.variant-markets .section-rule {
  grid-template-columns: minmax(72px, 100px) 1fr;
  gap: 14px;
  border-bottom: 1px solid rgba(159, 255, 208, 0.55);
}

.variant-markets h2 {
  font-family: var(--font-sans);
  font-size: 2.8rem;
  font-weight: 900;
  text-transform: uppercase;
}

.variant-markets .lead-story {
  grid-template-columns: minmax(220px, 0.62fr) 1fr;
  padding: 22px;
  border: 1px solid var(--rule);
  background: rgba(159, 255, 208, 0.07);
  box-shadow: inset 0 0 0 1px rgba(245, 213, 71, 0.22);
}

.variant-markets .lead-number {
  border: 0;
  font-family: var(--font-sans);
  font-size: 4.8rem;
  font-weight: 900;
  color: var(--accent);
}

.variant-markets .article-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.variant-markets .section-3 .article-grid,
.variant-markets .section-5 .article-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.variant-markets h3 {
  max-width: 18ch;
  font-family: var(--font-sans);
  font-size: 3rem;
  font-weight: 900;
}

.variant-markets h4 {
  font-family: var(--font-sans);
  font-size: 1.72rem;
  font-weight: 900;
  line-height: 1.02;
}

.variant-markets .article-card {
  min-height: 100%;
  padding: 16px;
  border: 1px solid rgba(159, 255, 208, 0.45);
  background: rgba(7, 17, 15, 0.86);
}

.variant-markets .lead-story p,
.variant-markets .article-card p {
  font-family: var(--font-sans);
  color: #d6f6ea;
  font-weight: 650;
}

.variant-review {
  --ft-paper: #f6f4ed;
  --ft-paper-deep: #e7edf7;
  --ink: #171c2a;
  --muted: #697186;
  --rule: #3157d5;
  --accent: #ff6b4a;
  background: #f6f4ed;
}

.variant-review .masthead {
  display: grid;
  grid-template-columns: minmax(0, 0.8fr) minmax(280px, 0.44fr);
  text-align: left;
  padding: 28px;
  background:
    linear-gradient(135deg, rgba(49, 87, 213, 0.14), transparent 44%),
    var(--ft-paper);
  border-bottom: 0;
}

.variant-review h1 {
  margin-inline: 0;
  max-width: 12ch;
  font-size: 5.4rem;
}

.variant-review .issue-meta {
  display: grid;
  gap: 10px;
  justify-content: stretch;
  margin-top: 0;
  text-align: left;
}

.variant-review .issue-meta span {
  width: 100%;
  border: 2px solid rgba(49, 87, 213, 0.3);
  border-radius: 8px;
  padding: 10px 12px;
  background: rgba(255, 255, 255, 0.55);
}

.variant-review .section {
  max-width: 980px;
  margin: 0 auto;
  padding: 20px 18px;
  border-bottom: 0;
  background: transparent;
}

.variant-review .section-rule {
  grid-template-columns: 56px 1fr;
  gap: 12px;
  text-align: left;
  border-bottom: 0;
  margin-bottom: 14px;
  padding-bottom: 0;
}

.variant-review .lead-story {
  grid-template-columns: 1fr;
  text-align: left;
  max-width: 100%;
  margin-inline: auto;
  padding: 20px;
  border: 2px solid rgba(49, 87, 213, 0.22);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 8px 0 rgba(49, 87, 213, 0.16);
}

.variant-review .lead-number {
  margin: 0;
  width: fit-content;
  aspect-ratio: auto;
  display: inline-block;
  border: 0;
  border-radius: 0;
  font-family: var(--font-sans);
  font-size: 2.4rem;
  color: var(--accent);
}

.variant-review h3 {
  margin-inline: 0;
  max-width: 15ch;
}

.variant-review .lead-story p {
  margin-inline: 0;
}

.variant-review .article-grid {
  grid-template-columns: 1fr;
  gap: 14px;
}

.variant-review .article-card {
  padding: 18px;
  border: 2px solid rgba(49, 87, 213, 0.18);
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 4px 0 rgba(23, 28, 42, 0.08);
}

.variant-review .article-card:nth-child(3n + 1) {
  grid-column: auto;
  display: block;
}

.variant-review .article-card:nth-child(3n + 1) h4 {
  margin-top: 0;
  font-size: 2.25rem;
}

.variant-review h2 {
  font-size: 2.8rem;
}

.variant-review h3 {
  font-size: 3.4rem;
}

.variant-review h4 {
  font-size: 2.05rem;
}

.variant-review .lead-story p,
.variant-review .article-card p {
  font-family: var(--font-text);
  font-weight: 650;
}

@media (max-width: 920px) {
  .masthead,
  .lead-story,
  .article-grid,
  .section-1 .lead-story,
  .section-3 .article-grid,
  .section-5 .article-grid,
  .variant-markets .issue-meta,
  .variant-markets .article-grid,
  .variant-markets .section-3 .article-grid,
  .variant-markets .section-5 .article-grid,
  .variant-markets .lead-story,
  .variant-review .article-grid,
  .variant-review .lead-story,
  .variant-review .article-card:nth-child(3n + 1) {
    grid-template-columns: 1fr;
  }

  .issue-meta {
    justify-items: start;
    text-align: left;
  }

  .lead-number {
    border-right: 0;
    border-bottom: 4px solid var(--rule);
    padding-bottom: 12px;
  }
}

@media (max-width: 1100px) and (min-width: 921px) {
  body {
    font-size: 1.2rem;
  }

  h1 {
    font-size: 6.4rem;
  }

  h2 {
    font-size: 4.2rem;
  }

  h3 {
    font-size: 4.2rem;
  }

  h4 {
    font-size: 2.1rem;
  }

  .lead-number {
    font-size: 7.6rem;
  }

  .variant-markets .article-grid,
  .variant-markets .section-3 .article-grid,
  .variant-markets .section-5 .article-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .variant-review .article-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  body {
    font-size: 1.08rem;
    line-height: 1.38;
  }

  .masthead,
  .section {
    padding-inline: 18px;
  }

  h1,
  .variant-markets h1,
  .variant-review h1 {
    font-size: 4.1rem;
  }

  h2,
  .variant-markets h2 {
    font-size: 2.6rem;
  }

  h3,
  .variant-markets h3,
  .variant-review h3 {
    max-width: 100%;
    font-size: 2.65rem;
  }

  h4,
  .variant-markets h4,
  .variant-review .article-card:nth-child(3n + 1) h4 {
    font-size: 1.7rem;
  }

  .variant-review h4 {
    font-size: 1.65rem;
  }

  .lead-number,
  .variant-markets .lead-number,
  .variant-review .lead-number {
    width: auto;
    aspect-ratio: auto;
    border-radius: 0;
    font-size: 3.5rem;
  }

  .variant-nav {
    position: static;
    padding-inline: 18px;
  }

  .variant-nav a {
    flex: 1 1 auto;
    text-align: center;
  }

  .variant-markets .lead-story {
    box-shadow: none;
  }
}

@media (min-width: 1000px) {
  .variant-review .article-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
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
