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

The workflow runs at 7am Europe/London every day. It schedules both 06:00 UTC and 07:00 UTC, then only proceeds when London local time is actually 07:00, so daylight saving time is handled.

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
