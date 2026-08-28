## Agent skills

### TranslationBot runtime operations

- For concise production requests such as "restart it", use the operator-workstation `./scripts/remote restart` wrapper. Use `status`, `start`, `stop`, `logs`, `update`, or `deploy` for the matching remote operation.
- The SSH destination, account, executable path, and project path belong only in the ignored owner-only `.translationbot-remote.json` file. Never put those values in tracked files, public issues, pull requests, commit messages, or user-facing bot output.
- Do not expose operational controls through Discord, invoke host-local launchd scripts on the operator workstation, or start a second manual `npm start` process.
- A remote update only fast-forwards the clean source checkout. Follow it with the health-checked release deployment to activate the new commit.

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Domain docs

This repository uses a single-context domain-documentation layout. See `docs/agents/domain.md`.
