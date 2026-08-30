# 1MB Translate Bot

This Discord moderation helper extracts Minecraft private-message log lines, signs, and book pages. A private local Ollama model decides conservatively whether each candidate needs translation and, only when confidence is high enough, returns a natural English translation.

The active translation path has no paid or cloud provider. If Ollama is unavailable, slow, overloaded, or returns suspicious output, the original text is left unchanged and the rest of the bot continues operating.

## Local AI architecture

The default model is `qwen3:8b` over Ollama's native loopback API at `http://127.0.0.1:11434`.

For each candidate, the bot:

1. Skips clearly nonlinguistic input, commands, obvious English, known game terms, and genuinely ambiguous short fragments without a model call.
2. Protects placeholders, Minecraft color codes, MiniMessage/Discord formatting, URLs, commands, punctuation, whitespace, and line breaks.
3. Sends only bounded current text and optional bounded in-memory conversation context to loopback Ollama.
4. Requests a low-temperature, non-thinking [structured output](https://docs.ollama.com/capabilities/structured-outputs) with this contract:

   ```json
   {
     "decision": "translate | leave_unchanged | uncertain",
     "source_language": "ISO code or und",
     "confidence": 0.0,
     "translation": "English translation or null",
     "reason_code": "foreign | english | mixed | proper_noun | too_short | nonlinguistic | uncertain"
   }
   ```

5. Validates the Ollama response envelope, exact configured model, fields, types, enums, cross-field meaning, size, formatting tokens, line structure, and output safety.
6. Gives one bounded second attempt to a confident non-English translation only when it dropped protected line/layout markers or copied the source unchanged. The retry stays inside the original timeout and must pass the same strict validation.
7. Shows a translation only for a valid `translate` decision at or above `OLLAMA_MIN_CONFIDENCE` (default `0.90`).

The client sends `stream:false`, `think:false`, temperature `0`, a fixed seed, and a small output budget through Ollama's [chat API](https://docs.ollama.com/api/chat). It never exposes model reasoning.

Every visible translation identifies its source in the heading. `Local AI` means the active Ollama model produced and passed validation for that translation. `Local dictionary` means the loopback legacy translator produced it in `off` or `shadow` mode. Active mode never silently changes to the dictionary path.

## Privacy and safety guarantees

- Ollama must use an IPv4 or IPv6 loopback HTTP address. LAN, public, HTTPS, credentialed, path-bearing, and `0.0.0.0` endpoints fail configuration validation.
- Cloud-model names are rejected. There are no OpenAI, Gemini, Groq, or other paid-provider credentials or SDKs in the translation path.
- This project never installs Ollama, signs in, enables web search, or downloads a model during install or startup.
- Ollama should run with cloud features disabled (`OLLAMA_NO_CLOUD=1` or `disable_ollama_cloud`), as described in the [Ollama FAQ](https://docs.ollama.com/faq).
- Original messages, prompts, translations, raw model responses, and translation history are not written to logs or disk.
- Result-cache keys are SHA-256 identities rather than raw text. Results and conversation context are bounded, in memory only, and expire.
- Player names are not sent as model context. Prior translated turns are bounded and anonymized before a local request.
- Discord mentions are neutralized in displayed text and every send disables allowed mentions.
- Model-added mentions, URLs, commands, formatting, extra line breaks, and malformed or oversized output are rejected.
- Player text and prior context are explicitly treated as untrusted data, never instructions.
- Logs and health output contain aggregate decisions, latency, cache/queue counts, and safe error codes only.

## Rollout modes

`OLLAMA_MODE` controls the migration:

- `off`: use the existing loopback-only LibreTranslate path and make no Ollama request.
- `shadow`: preserve legacy visible output while Ollama decisions run privately in a bounded background queue.
- `active`: Ollama alone controls translations. It never falls back to LibreTranslate when Ollama fails.

The checked-in example uses `active`. Use `shadow` first if you want an observation period before changing visible output. `off` and `shadow` reject non-loopback LibreTranslate URLs so those modes also keep analyzed text local.

## Installation and configuration

Requirements:

- Node.js 20 or newer
- a Discord bot with Message Content Intent and access to the configured channels
- a separately managed Ollama service with `qwen3:8b` already installed

Install the JavaScript dependencies and create the private environment file:

```bash
npm install
cp .env.example .env
```

Set the Discord token, server ID, required message-log channel ID, and the immutable ID of every trusted logging bot or webhook in `.env`. Real tokens, IDs, hostnames, usernames, and paths belong only in ignored local configuration. Automated sources fail closed when neither `SOURCE_BOT_IDS` nor `SOURCE_WEBHOOK_IDS` is configured. `ALLOW_ANY_SOURCE=true` is an explicit compatibility opt-in for a tightly controlled watched channel; it is not the default.

To avoid translating content from players whose language the moderation team already understands, set `IGNORED_PLAYER_NAMES` in the owner-only `.env` to a comma-separated list of Minecraft names. Matching is case-insensitive and exact. It applies to private-message senders, sign placers, and book editors; matching a message recipient alone does not skip translation. Ignored content never reaches Ollama or the legacy translator, while deterministic local risk checks remain active.

The minimum active configuration is:

```env
DISCORD_TOKEN=your-private-token
DISCORD_GUILD_ID=your-server-id
LOG_CHANNEL_ID=your-message-log-channel-id
SOURCE_BOT_IDS=your-logging-bot-id

OLLAMA_MODE=active
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:8b
OLLAMA_MIN_CONFIDENCE=0.90
```

See [.env.example](.env.example) for timeout, queue, cache, context, circuit-breaker, output, and legacy settings.

The optional `npm run libretranslate` command only starts an already provisioned legacy environment. It never creates a virtual environment or installs packages. If legacy `off` or `shadow` mode is required, provision `.venv-libretranslate` separately from a reviewed, fully version- and hash-locked dependency set.

### Private transport when developing from another computer

Production is simplest when the bot and Ollama run on the same host and communicate over loopback. For a temporary development check from another trusted computer, use an existing private SSH connection and bind only a local loopback port:

```bash
ssh -N -L 127.0.0.1:11435:127.0.0.1:11434 <private-host-alias>
OLLAMA_BASE_URL=http://127.0.0.1:11435 npm run ollama:status
```

Do not change Ollama to listen on a LAN interface and do not commit the private host alias.

## Health and failure behavior

Run the privacy-safe readiness check:

```bash
npm run ollama:status
```

It reports only whether the Ollama service and configured model are available. It does not print the endpoint, hostname, username, path, model inventory, prompts, or responses.

Runtime protection defaults:

- one active Ollama request and sixteen queued requests
- a 45-second request timeout and 2-second health timeout
- circuit opens after three consecutive provider failures and retries after 60 seconds
- 2,000 cached decisions for six hours, in memory only
- simultaneous normalized requests share one in-flight model call
- Discord message processing has its own bounded queue

A timeout, queue rejection, open circuit, connection error, missing model, invalid JSON/schema, wrong model identity, unsafe output, low-confidence/uncertain decision, or failed repair produces no translation. Unsafe formatting and low-confidence output are never retried. Active mode never invokes the legacy provider as a fallback.

## Testing

Normal checks use mocked Ollama responses and never require a model or download:

```bash
npm run check
```

Useful individual commands:

```bash
npm test
npm run lint
npm run build
```

The project is plain CommonJS JavaScript, so `lint` and `build` perform syntax validation; there is no separate TypeScript compilation step.

Run the optional live integration test only when a loopback Ollama endpoint is ready:

```bash
RUN_OLLAMA_INTEGRATION=1 npm run test:ollama
```

The test uses synthetic Dutch and French text and verifies model readiness, the conservative threshold, placeholder preservation, punctuation preservation, and exact multiline sign layout. It never uses production messages.

## Synthetic evaluation

The version-controlled corpus at `fixtures/translation-evaluation.json` contains synthetic English, names, game terms, commands, ambiguous fragments, Dutch, Polish, Spanish, French, German, Portuguese, Italian, Russian, Japanese, mixed-language, formatted, injection-attempt, and multiline cases.

Run it against the configured local model:

```bash
npm run evaluate
```

It compares the old dictionary-style candidate gate with the active Ollama gate and reports false positives, false negatives, accepted translation quality, formatting preservation, and provider errors separately. It prints fixture IDs for synthetic cases needing review, never message text or raw responses.

Verified on 2026-08-28 with local `qwen3:8b`:

```text
Synthetic fixtures: 33
Legacy candidate gate: 20 false positives, 1 false negative
Ollama active gate: 0 false positives, 0 false negatives
Accepted translation quality: 13/13 (100%)
Legacy false-positive reduction: 100%
Provider errors: 0
```

Model versions and local runtimes can change behavior, so rerun the corpus before each model or Ollama upgrade.

## Running the bot

Start in the foreground:

```bash
npm start
```

Startup reports Discord access, rollout mode, bounded capacity, and privacy-safe provider readiness. It does not print message content, private destination IDs, endpoints, hostnames, or raw errors.

Members with Discord's Manage Server permission can use the guild-scoped commands:

```text
/translationbot health
/translationbot alert-test
```

Both replies are ephemeral and privacy-safe. `health` reports the running process, Discord/channel/command readiness, active local provider, circuit, cache, queues, aggregate activity, version, release, and uptime. `alert-test` returns the same view with a simulated attention marker and never stops, restarts, or changes the service. No start, stop, restart, log, update, or deployment control is exposed through Discord.

Deterministic risk flags remain available through `ENABLE_RISK_FLAG` and `FLAGGED_TERMS`. They are independent of Ollama availability and do not turn a failed translation into a legacy fallback.

## Managed macOS service

The production host can run TranslationBot as the per-user LaunchAgent `com.mrfdev.translationbot`. The tracked plist is a sanitized template containing no username, home path, Discord destination, credential, or private host. `RunAtLoad` starts the bot after login, and `KeepAlive` restarts it after an unexpected failure. Do not run a second manual `npm start` process beside the managed service.

Host-local operations are:

```bash
./scripts/install
./scripts/start
./scripts/stop
./scripts/restart
./scripts/status
./scripts/health
./scripts/health --json
./scripts/health --alert-test
./scripts/logs --lines 100
./scripts/logs --follow
./scripts/deploy
./scripts/deploy --rollback
```

Service output is captured in owner-only `logs/translationbot-service.log` and `logs/translationbot-service.error.log`. The two streams rotate independently, keep a bounded archive count, and stop accepting writes before the configured free-disk reserve would be consumed. They contain timestamps and privacy-safe operational records, not Discord message text or model responses.

`health` combines launchd state with a fresh owner-only runtime snapshot. It checks the active release and version, Discord gateway/server/channel/slash-command readiness, configured translation backend, Ollama circuit, caches, queues, context counts, aggregate activity, uptime, and memory. Exit status `0` means healthy, `2` means running but requiring attention, and `3` means unavailable. `--json` provides the same bounded data for monitoring. `--alert-test` deliberately returns attention status `2` with the safe code `alert-test`, without stopping or changing the service, so alert wiring can be tested. The runtime refreshes the snapshot every `HEALTH_SNAPSHOT_INTERVAL_MS` (30 seconds by default).

Deployment is release-based. The deployer exports only the committed Git revision into an ignored staging directory, runs `npm ci` and the complete local check before activation, links the owner-only host `.env` and persistent logs, then atomically switches the active release. The LaunchAgent executes its runner and logging code from that selected verified release, while explicit environment values point it back to persistent owner-only state under the project root. It succeeds only after launchd reports a running process and fresh service output confirms Discord plus the configured local translation backend are available. Failed activation restores and verifies the preceding release; explicit rollback swaps the last two verified releases.

For remote operation from an authorized workstation, create the ignored owner-only configuration:

```bash
cp .translationbot-remote.example.json .translationbot-remote.json
chmod 600 .translationbot-remote.json
```

Fill in the SSH destination and absolute remote Node/project paths, then use the narrow wrapper:

```bash
./scripts/remote status
./scripts/remote health
./scripts/remote health --json
./scripts/remote health --alert-test
./scripts/remote ollama-status
./scripts/remote start
./scripts/remote stop
./scripts/remote restart
./scripts/remote logs --lines 100
./scripts/remote logs --follow
./scripts/remote update
./scripts/remote deploy
./scripts/remote deploy --rollback
```

The wrapper uses noninteractive SSH, accepts only these operations and bounded log arguments, and never exposes controls through Discord. `update` permits only a clean fast-forward of the configured upstream and never restarts the bot. Run `deploy` afterward to stage, validate, and activate the new commit.
