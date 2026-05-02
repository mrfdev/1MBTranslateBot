# 1MB Translate Bot

This bot watches one Discord logging channel, extracts Minecraft private-message log lines such as `/cmi msg player text`, detects the language, and replies underneath with an English translation.

Default target:

- Server: `487398800353263616`
- Channel: `807177293943275530`

Example output:

```text
(Polish) `postaw pochodnie` == `place torches`
:triangular_flag_on_post: (Dutch) `...` == `...`
```

## What it uses

- `discord.js` for Discord.
- LibreTranslate for translation. This can use your own free self-hosted instance, or a hosted endpoint if you have an API key.
- Local keyword heuristics for the `:triangular_flag_on_post:` warning. This is useful as a moderation hint, not a perfect hate-speech classifier.

Public translation endpoints can be rate-limited, unavailable, or require an API key. The best no-credit-card path is self-hosting LibreTranslate on the same VPS or another always-on machine.

## 1. Create the Discord bot

1. Open the Discord Developer Portal: <https://discord.com/developers/applications>
2. Create a new application.
3. Go to **Bot** and create a bot.
4. Copy the bot token.
5. Enable **Message Content Intent** under the bot's privileged gateway intents.
6. Invite the bot to your server with these permissions:
   - View Channel
   - Read Message History
   - Send Messages
   - Use External Emojis is optional

Invite URL pattern:

```text
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=68608&scope=bot
```

Replace `YOUR_CLIENT_ID` with the application/client ID from the Developer Portal.

For this bot application, the current invite URL is:

```text
https://discord.com/oauth2/authorize?client_id=1499923232843894794&permissions=137439333440&scope=bot
```

After inviting it, the bot should appear as a member of the server. If it does not, make sure you selected server `487398800353263616` while logged in with a Discord account that has **Manage Server** permission.

## 2. Install the bot

From this folder:

```bash
npm install
cp .env.example .env
nano .env
```

Set at least:

```env
DISCORD_TOKEN=your-real-token
DISCORD_GUILD_ID=487398800353263616
LOG_CHANNEL_ID=807177293943275530
```

Leave `SOURCE_BOT_IDS` blank at first. The bot will watch any bot/webhook message in the channel except itself. Once you know the MSG SPY bot's Discord user ID, set:

```env
SOURCE_BOT_IDS=the-msg-spy-bot-user-id
```

That prevents the translator from reacting to other bots in the same channel.

## 3. Run free translation locally

LibreTranslate is free and open source. Run it in a second `tmux` session:

```bash
tmux new -s libretranslate
cd /Users/floris/Projects/Codex/1MBTranslateBot
npm run libretranslate
```

Detach from tmux with `Ctrl-b`, then `d`.

On macOS/Homebrew Python, installing with `python3 -m pip install --user libretranslate` can fail with `externally-managed-environment`. The `npm run libretranslate` command avoids that by creating a local `.venv-libretranslate/` virtual environment and installing LibreTranslate there.

The bot defaults to:

```env
LIBRETRANSLATE_URL=http://127.0.0.1:5000
LIBRETRANSLATE_API_KEY=
```

If you use hosted LibreTranslate instead, set the hosted URL and put the key in `LIBRETRANSLATE_API_KEY`.

Optional: LibreTranslate can provide alternative translations:

```env
TRANSLATION_ALTERNATIVES=2
MAX_TRANSLATIONS_PER_MESSAGE=1
```

`TRANSLATION_ALTERNATIVES` asks LibreTranslate for extra options. `MAX_TRANSLATIONS_PER_MESSAGE` controls how many the Discord bot prints. The default is `1` to keep moderation logs readable.

## 4. Run it

Test in the foreground:

```bash
npm start
```

Run it in `tmux`:

```bash
tmux new -s translatebot
cd /Users/floris/Projects/Codex/1MBTranslateBot
npm start
```

Detach from tmux with `Ctrl-b`, then `d`.

Reattach later:

```bash
tmux attach -t translatebot
```

Stop it while attached:

```bash
Ctrl-c
```

## 5. Risk flag tuning

The bot has a small built-in profanity/risk list and checks both the original text and the translation. Add your own community-specific terms in `.env`:

```env
FLAGGED_TERMS=term one,term two,term three
```

Disable flagging:

```env
ENABLE_RISK_FLAG=false
```

## Notes

- English messages are skipped when language detection is confident enough.
- Very short messages such as `cmok` can be hard for any free language detector. The bot still tries, but expect occasional misses.
- The bot asks LibreTranslate for alternatives when supported. Natural alternatives like `kiss` / `mwah` are still only a machine-translation hint.
