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

Both `data/tldr-ai/raw/` and `tldr-magazines/` are gitignored. This keeps the subscribed newsletter content out of the public GitHub Pages repo.

## Daily Automation

The Codex automation named `TLDR AI Reader` fetches the latest inbox email from `dan@tldrnewsletter.com`, writes its body to `data/tldr-ai/raw/latest.md`, and runs `npm run generate:tldr-ai`.

## Publishing Note

The default setup does not publish TLDR's full email content to GitHub Pages. For a public version, generate a summary-and-links edition instead of republishing the full newsletter text.
