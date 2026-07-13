# skillkill

![skillkill token-cost receipt logo](assets/skillkill-token-receipt.png)

![Uploading CleanShot 2026-07-13 at 21.52.24@2x.png…]()

Audit local agent skills, find stale or never-used installs, and clean them up
through an undoable quarantine.

## Quick Start

Run without installing:

```bash
npx skillkill
```

Or install globally:

```bash
npm install --global skillkill
skillkill
```

In a real terminal, `skillkill` opens an interactive review. When output is
piped, or when `--no-interactive`, `--json`, `--csv`, or `--snapshot` is used,
it prints static output instead.

Interactive screens use terminal colors when supported. Set `NO_COLOR=1` to
disable color.

## What It Does

`skillkill` scans installed skill directories, then checks local agent history
for evidence that each skill was actually used.

- Default skill roots: `~/.agents/skills`, `~/.claude/skills`,
  `~/.codex/skills`, and `~/.cursor/skills`
- Usage: native skill-invocation records and structured skill actions from supported tools
- Mention: raw `SKILL.md` path/name mentions in supported local stores
- Cleanup candidates: stale usage or never-used skills past the age
  threshold
- Protected rows: dot-prefixed system skills, recent usage, recent mentions,
  and omitted skills

Mentions do not prove a skill was invoked, but recent mentions keep a skill out
of cleanup candidates because they may indicate use in tools without native
attribution.

## Safety Model

- Default runs do not move files.
- Interactive cleanup requires selecting rows, pressing `enter` to review, then
  pressing `enter` again to move them to quarantine.
- From the review screen, pressing `d`, typing `DELETE`, then pressing `enter`
  permanently deletes the selected skills instead of quarantining them.
- `--apply` moves candidates into `~/.local/state/skillkill/runs/...`; it does
  not permanently delete them.
- Permanent delete does not write an undo manifest.
- If a quarantined skill is tracked by `npx skills`, matching Vercel lock
  entries are removed from `~/.agents/.skill-lock.json`,
  `$XDG_STATE_HOME/skills/.skill-lock.json`, or an existing project
  `skills-lock.json`, then saved in the undo manifest.
- `skillkill --undo` or `skillkill undo` opens an interactive restore picker.
- `skillkill --undo latest`, `skillkill undo latest`, `--undo RUN_ID`, and
  `--undo PATH` restore directly for scripts, including any Vercel lock entries
  saved by cleanup.
- `--omit`, `--whitelist`, and `~/.config/skillkill/omit` keep known-good skills
  out of cleanup candidates.
- Symlinked skill installs are treated as installs. Cleanup moves the symlink
  into quarantine, not the symlink target.

## Docs

- [Plan](docs/plan.md)
- [CLI design](docs/design/skillkill-cli.md)
- [ADR: Build `skillkill` as a terminal-first cleanup CLI](docs/adr/terminal-first-skillkill-cli.md)
- [ADR: Classify skill usage evidence by confidence](docs/adr/classify-skill-usage-evidence.md)
- [Research: tools like `npx npkill`](docs/research/npkill-like-tools.md)
- [Research: skill invocation signals](docs/research/skill-invocation-signals.md)

## Usage

```bash
# Interactive review
npx skillkill
skillkill

# Scan different skill roots or evidence sources
skillkill --path ~/.agents/skills
skillkill --path ~/.agents/skills --path ~/.claude/skills
skillkill --source opencode
skillkill --source cursor
skillkill --evidence-dir ~/.continue

# Keep known-good skills out of cleanup candidates
skillkill --omit simplify
skillkill --omit "ck-*"
skillkill omit simplify

# Static output for scripts and review artifacts
skillkill list --json
skillkill --no-interactive
skillkill --commands
skillkill --json
skillkill --csv /tmp/skillkill.csv
skillkill --snapshot ~/.codex/skillkill/snapshots.jsonl

# Cleanup and restore
skillkill cleanup --apply
skillkill --apply
skillkill --undo
skillkill --undo latest
skillkill undo latest
```

Rows include `risk`, `description_token_cost`, and `used_window_tokens`. Token
cost is a rough estimate from the skill `description` frontmatter field.
`used_window_tokens` is observed cost from usage events in the current
`--savings-days` window. Human tables show `30d burn` by default: each skill's
description tokens multiplied by distinct new local chat/session artifacts found
in the last `--savings-days` window. The interactive table keeps full install
paths out of the list view; it shows compact install-source labels there and
prints the full paths in the confirmation review before cleanup.

The interactive confirmation screen shows the selected skills, description
tokens removed per future skill-catalog load, and observed token cost from
recent usage events of the selected skills. It also shows potential new-chat
savings: removed description tokens multiplied by distinct new local chat/session
artifacts found in the last `--savings-days` window.

## Interactive Keys

| Key | Action |
| --- | --- |
| `up` / `down` or `j` / `k` | Move through rows |
| `/` | Search visible cleanup candidates |
| `space` or `x` | Select or unselect the current skill |
| `a` | Toggle all cleanup candidates |
| `o` | Omit the current skill |
| `t` / `b` / `r` / `i` / `u` | Sort by tokens, burn, risk, installed, or last used |
| `enter` | Open review, keep search, or confirm cleanup/restore |
| `d` | Enter permanent-delete mode from cleanup review |
| `y` | Confirm cleanup or restore shortcut |
| `n` / `esc` | Cancel confirmation |
| `q` | Quit |

Interactive omit appends the skill name to `~/.config/skillkill/omit` unless
`--no-omit-file` is set, in which case the omit lasts only for the current run.

## Core Options

| Option | Purpose |
| --- | --- |
| `--path PATH`, `--skills-dir PATH` | Skills directory to scan; repeatable |
| `--source codex|claude|opencode|cursor|filesystem|all` | Evidence source to scan |
| `--evidence-dir PATH` | Extra transcript or log directory for mentions |
| `--unused-days N` | Mark skills stale after last use |
| `--unused-installed-days N` | Propose never-used skills after install age |
| `--protect-mention-days N` | Defer cleanup after recent mentions |
| `--protect-weak-days N` | Deprecated alias for `--protect-mention-days` |
| `--savings-days N` | Estimate token savings from recent activity |
| `--omit PATTERN`, `--whitelist PATTERN` | Keep matching skills out of cleanup candidates |
| `skillkill omit PATTERN` | Persist an omit pattern |
| `--no-interactive` | Print the static table |
| `--json`, `--csv PATH`, `--snapshot PATH` | Machine-readable or persistent outputs |
| `cleanup --apply`, `--apply` | Move cleanup candidates to quarantine |
| `undo [latest|RUN_ID|PATH]`, `--undo [latest|RUN_ID|PATH]` | Restore a quarantine run |
| `--full-scan` | Parse every JSONL line instead of prefiltering |

Run `skillkill --help` for the complete command reference.

## Supported Tools

| Tool | Default locations | Usage | Mentions |
| --- | --- | --- | --- |
| Codex | `~/.codex/sessions`, `~/.codex/archived_sessions`, plugin cache skill roots | Injected `<skill><name>...<path>...` transcript blocks; shell commands that read `SKILL.md`; commands that execute files under a skill `scripts/` directory | Raw `SKILL.md` path references when included in scanned records; broader path discovery with `--full-scan` |
| Claude / Claude Code | `~/.claude/history.jsonl`, `~/.claude/projects`, `~/.claude/tasks`, `~/.claude/sessions`, `~/Library/Application Support/Claude/claude-code-sessions`, `~/Library/Application Support/Claude/local-agent-mode-sessions`, `~/.claude.json` | `attributionSkill` records; native `Skill` tool calls; invoked-skill attachments; slash-command skill tags; autocomplete `skillUsage.lastUsedAt`; structured read tool calls or shell commands that read `SKILL.md`; commands that execute files under a skill `scripts/` directory | Raw `.claude/skills/.../SKILL.md` or `.agents/skills/.../SKILL.md` path references |
| OpenCode | `~/.local/share/opencode/storage/message`, `storage/part`, `storage/session/message`, `storage/session/part` | Structured `read` tool parts whose input targets an installed `SKILL.md` | Raw `SKILL.md` path references in message or part JSON |
| Cursor | `~/.cursor/projects/**/agent-transcripts/*.jsonl`, `~/.cursor/chats/**/store.db` | Structured read tool calls in agent transcripts whose input targets an installed `SKILL.md` | Raw `SKILL.md` path references found in agent transcripts or chat DB blobs |
| Extra filesystem roots | Paths passed with `--evidence-dir` | Structured read tool records or shell commands that read `SKILL.md` | Raw `SKILL.md` path references |

Usage drives `last_used`; `last_verified_use` remains as a compatibility alias.
Mentions contribute to `last_seen` and `last_any_signal`, and protect recent
matches from automatic cleanup, but remain lower confidence.

Codex plugin-cache skills are reported for visibility, but are protected from
cleanup because they are managed by the plugin cache.

## Whitelist / Omit

Use `--omit` to keep a skill out of cleanup candidates:

```bash
skillkill --omit simplify
skillkill --omit "ck-*"
skillkill --whitelist simplify
```

For persistent omissions, add one skill name or glob per line:

```text
~/.config/skillkill/omit
```

Blank lines and `#` comments are ignored. Omit patterns match skill names,
`SKILL.md` paths, and skill directory paths.

Published alias packages delegate to the same CLI:

```bash
npx skill-cleanup
npx skill-prune
```

Installing `skillkill` also exposes `skill-kill` as a local/global command
alias. npm blocks `skill-kill` as a separate package name because it is too
similar to `skillkill`.

## Development

```bash
npm test
npm run check
npm run build
npm run link:local
```

`npm run link:local` links `skillkill`, `skill-kill`, `skill-cleanup`, and
`skill-prune` into `~/.local/bin` for testing this checkout from any shell.

## Publishing

Publishing is done only by GitHub Actions. The publish workflow supports a
manual dry run and publishes `skillkill`, `skill-cleanup`, and `skill-prune`
from pushes to `master` or from version tags.
