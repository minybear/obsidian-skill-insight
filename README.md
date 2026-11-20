# Skill Insight

A desktop-only [Obsidian](https://obsidian.md) plugin that turns your AI agent sessions into an insight dashboard: which skills you use, how often, in which sessions, and how your skills evolve over time.

![manifest version](https://img.shields.io/badge/version-0.7.0-blue) ![desktop only](https://img.shields.io/badge/platform-desktop-lightgrey) ![license](https://img.shields.io/badge/license-MIT-green)

## What it does

- **Auto-initialization** — on startup the plugin scans your configured skill directories (`.agents/skills`, `.claude/skills`, `.codex/skills` in your vault) and creates a dashboard card for every installed skill, with no confirmation dialogs.
- **Usage mining from session transcripts** — on first open it back-fills usage records from the last 7 days of local agent session transcripts (Codex CLI, Claude Code); new skills get their history re-scanned, so usage that happened before the card existed is counted retroactively. After that, it ingests new transcript lines incrementally each time the dashboard opens.
- **Signal detection** — counts explicit `Skill` tool calls, plus commands that directly read `SKILL.md` files (each distinct skill counted once per session). Patch-write operations and scripted bulk scans (6+ skill paths in one command) are ignored; directory listings, command outputs and chat prose never participate in matching.
- **Insight dashboard** with five tabs:
  - **Overview** — usage ranking, an 8-week activity heatmap (click a cell to drill into that day), session volume, and revision activity.
  - **Skill detail** — per-skill timeline of usage and revisions.
  - **Sessions** — usage grouped by agent session, shown as searchable cards with clickable skill chips.
  - **Revision timeline** — how your skills changed over time (r0, r1, r2 …).
  - **Sources & ingest** — read-only discovery report and ingest controls.

- **Pending change detection** — on every dashboard refresh, the plugin hashes each tracked skill's `SKILL.md` against the latest registered revision. Unregistered changes surface as a yellow draft (overview strip + skill detail) with a diff preview; they only become a numbered revision (r1, r2, …) after you fill in the change reason and verification result. Reverting the file clears the draft automatically.

- **Settings tab** — a settings entry in Obsidian's community-plugins list, with a dashboard shortcut and transcript ingest configuration (global fallback toggles and roots).

## Privacy & data safety

- **No vault writes.** All plugin data lives inside the plugin's own folder (`data.json` in `.obsidian/plugins/skill-insight/`). Your notes are never touched.
- **No network.** Everything is parsed locally; the plugin never calls out to the internet.
- **Scope by default.** Usage mining reads only sessions registered by the Claudian plugin for the current vault, plus sessions whose own metadata (`cwd` / project directory) proves they were started in this vault. A global transcript scan is available but off by default.

## How it finds your sessions

| Agent | Source |
| --- | --- |
| Codex CLI | `~/.codex/sessions/**/rollout-*.jsonl` (`.zst`-compressed archives are skipped) |
| Claude Code | `~/.claude/projects/&lt;encoded-vault-path&gt;/*.jsonl` |
| Claudian registry | `.claudian/sessions/conv-*.meta.json` in the vault, used to map sessions to this vault and to provider backends |

## Installation

### From the community plugin store (after approval)

1. Open **Settings → Community plugins**.
2. Turn off restricted mode, click **Browse**, search for "Skill Insight" and install.

### Manual / BRAT (before approval)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. Run the command **BRAT: Add a beta plugin** and enter `minybear/skill-insight`.

Or copy `main.js`, `styles.css`, `manifest.json` into `<vault>/.obsidian/plugins/skill-insight/` and reload.

## Limitations

- Desktop only (requires Node.js filesystem access).
- Only Codex CLI and Claude Code transcripts are mined today; other Claudian backends are on the roadmap.
- Transcripts that the agent CLI has already compressed to `.zst` archives cannot be parsed and are skipped.

## License

[MIT](LICENSE) © Awei (minybear)
