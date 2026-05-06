# Morning Edition

A daily Hacker News magazine that curates the front page for AI tools, health, finance, weird science, and actionable stories.

## Generate Locally

```bash
npm run generate
```

The issue is written to `magazines/YYYY-MM-DD.html`, and `magazines/index.html` redirects to the newest issue.

## Publish With GitHub Pages

1. Create a GitHub repository and push this project.
2. In GitHub, open `Settings -> Pages`.
3. Under `Build and deployment`, set `Source` to `GitHub Actions`.
4. Open `Actions -> Daily Morning Edition` and run it once manually.

The workflow is scheduled for the 8am Europe/London window. Two UTC cron entries cover daylight-saving changes, and the workflow publishes on the first scheduled run at or after 8am London time, then skips later scheduled runs once that day's issue exists.

## Article Summaries

Each Hacker News story includes a roughly 200-word brief. If you add an `OPENAI_API_KEY` repository secret, the workflow uses the OpenAI Responses API to summarize the fetched article text. Without that secret, it still produces a local fallback brief from readable article text, metadata, and Hacker News context.

## Official AI Lab News

Each issue starts with new first-party updates from Anthropic News and OpenAI company/global announcements. The generator keeps `data/official-news-seen.json` so a missed previous-day article is included in the next issue, while already-published items are not repeated on later days.

Optional repository secrets:

```text
OPENAI_API_KEY
OPENAI_SUMMARY_MODEL
```

`OPENAI_SUMMARY_MODEL` is optional; the default is configured in `config/morning-edition.json`.

## Telegram Setup

1. In Telegram, message `@BotFather`.
2. Send `/newbot`, choose a name, then choose a bot username.
3. Copy the bot token BotFather gives you.
4. Send any message to your new bot.
5. Visit this URL in a browser, replacing `<TOKEN>` with your token:

   ```text
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```

6. Find your chat id in the JSON response at `message.chat.id`.
7. In your GitHub repo, open `Settings -> Secrets and variables -> Actions -> New repository secret`.
8. Add `TELEGRAM_BOT_TOKEN` with the bot token.
9. Add `TELEGRAM_CHAT_ID` with the chat id.

The workflow skips the Telegram step until both secrets exist.

## Taste Tuning

Edit `config/morning-edition.json` to adjust what counts as your taste, how strongly each category is weighted, and which categories should be flagged as directly applying to you.

## TLDR AI Reader

There is also a private Financial Times-inspired renderer for the daily TLDR AI email. It preserves TLDR's sections, removes `(Sponsor)` articles, and writes local-only output under `tldr-magazines/`.

See [docs/tldr-ai-reader.md](docs/tldr-ai-reader.md).
