# TLDR AI Reader

This is a private/local renderer for the daily TLDR AI email from `dan@tldrnewsletter.com`.

It preserves the newsletter's grouping, removes any article whose title contains `(Sponsor)`, and renders the result as a Financial Times-inspired HTML issue.

## Generate

Save the latest TLDR AI email body as:

```text
data/tldr-ai/raw/latest.md
```

Then run:

```bash
npm run generate:tldr-ai
```

The output is written to:

```text
tldr-magazines/YYYY-MM-DD.html
```

It also writes three UI variants:

```text
tldr-magazines/YYYY-MM-DD-broadsheet.html
tldr-magazines/YYYY-MM-DD-markets.html
tldr-magazines/YYYY-MM-DD-review.html
```

The default `YYYY-MM-DD.html` uses the Broadsheet version. Each issue includes a small version switcher at the top.

The three layouts are intentionally different:

- `broadsheet`: classic FT-pink lead-story layout with large section openers.
- `markets`: green-tinted dashboard grid with boxed cards and denser scanning.
- `review`: warmer rose editorial-review layout with centered masthead and feature-style article breaks.

Both `data/tldr-ai/raw/` and `tldr-magazines/` are gitignored. This keeps the subscribed newsletter content out of the public GitHub Pages repo.

## Typography

The CSS uses FT-style font-family names first:

```css
"FinancierDisplayWeb", "Financier Display", "Financier", Georgia, serif
"FinancierTextWeb", "Financier Text", Georgia, serif
"MetricWeb", "Metric", Arial, sans-serif
```

The actual Financial Times fonts are proprietary, so the page falls back to local/system fonts unless you have licensed FT/Klim fonts installed locally.

## Telegram Notification

Copy the example env file:

```bash
cp .env.example .env.local
```

Then edit `.env.local` in the project root:

```text
TELEGRAM_BOT_TOKEN=1234567890:AAExampleTokenLettersNumbers
TELEGRAM_CHAT_ID=123456789
```

Then run:

```bash
npm run notify:tldr-ai
```

The notifier sends the generated HTML issue as a Telegram document. It reads `.env.local` locally only; the file is gitignored and should not be committed.

To generate and notify in one command after `data/tldr-ai/raw/latest.md` exists:

```bash
npm run send:tldr-ai
```

To test Telegram without a generated issue:

```bash
npm run notify:tldr-ai:test
```

## Daily Automation

The Codex automation named `TLDR AI Reader` fetches the latest inbox email from `dan@tldrnewsletter.com`, writes its body to `data/tldr-ai/raw/latest.md`, runs `npm run generate:tldr-ai`, then runs `npm run notify:tldr-ai`.

## Publishing Note

The default setup does not publish TLDR's full email content to GitHub Pages. For a public version, generate a summary-and-links edition instead of republishing the full newsletter text.
