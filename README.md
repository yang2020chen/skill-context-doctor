# skill-context-doctor

> **Audit real Agent Skill usage, context cost, duplication, and lifecycle health.**

You installed dozens or hundreds of Agent Skills.
- Which ones are **actually used**?
- Which ones **permanently consume context**?
- Which ones are **duplicated or broken**?

`skill-context-doctor` audits local agent skills across **Claude Code**, **Codex**, **Pi**, **OpenCode**, and **Cursor** by inspecting actual transcripts and execution history rather than guessing.

---

## The Problem: Context Bloat & Skill Sprawl

In modern agent workflows, skills inject descriptions directly into system prompts. Over time, repositories and agent configurations accumulate hundreds of skills:

```text
Real-world Benchmark:
  276 discovered skills
  → 16 actually model-visible skills

  ~31,000 system prompt tokens
  → ~3,000 tokens after cleanup (90% reduction)
```

Without an audit trail, stale skills silently waste input context window and API tokens on every single turn.

---

## Core Capabilities (v0.1 Audit)

- **Multi-Agent Discovery**: Scans installed skills across `~/.agents/skills`, `~/.claude/skills`, `~/.codex/skills`, `~/.cursor/skills`, and `~/.pi/agent/skills`.
- **Verified Usage Evidence**: Scans local agent session logs for verified usage:
  - Explicit slash commands (e.g. `/skill:name` in Pi agent)
  - Structured tool calls reading `SKILL.md` (Codex, Claude, Pi, OpenCode, Cursor)
  - Shell inspection commands (`cat`, `head`, `sed`) reading skill files
- **Evidence vs Mention Distinction**: Differentiates verified executions (`usage`) from bare path mentions (`mentions`), preventing premature cleanup while avoiding false positives.
- **Context Token Overhead**: Measures exact token weight of skill descriptions loaded into system prompts.
- **Symlink & Duplicate Grouping**: Detects duplicate installs and symlinks across different agent directories.
- **Safe Quarantine & Instant Undo**: Moves cleanup candidates to an isolated quarantine state (`~/.local/state/skill-context-doctor/runs/`) with full, atomic undo capability.
- **Terminal-First & Scriptable**: Interactive review when running in a TTY; structured JSON output (`--json`) and dry-run table when piped.

---

## Quick Start

Run instantly with `npx`:

```bash
npx skill-context-doctor
```

Or install globally:

```bash
npm install --global skill-context-doctor
skill-context-doctor
```

### Common Commands

```bash
# Audit specific skill roots
skill-context-doctor --path ~/.agents/skills
skill-context-doctor --path ~/.agents/skills --path ~/.claude/skills

# Filter by evidence source
skill-context-doctor --source pi
skill-context-doctor --source claude
skill-context-doctor --source codex
skill-context-doctor --source opencode
skill-context-doctor --source cursor

# Output structured JSON for automation
skill-context-doctor list --json

# Exclude trusted skills
skill-context-doctor --omit "my-special-skill"
skill-context-doctor omit "ck-*"

# Quarantine candidates and restore
skill-context-doctor cleanup --apply
skill-context-doctor undo latest
```

---

## Status Classification (v0.1)

In v0.1, `skill-context-doctor` delivers objective facts without autonomous deletion decisions:

| Status | Meaning |
| --- | --- |
| `USED` | Verified execution evidence found in recent agent histories. |
| `STALE` | Previously used, but no activity detected within the staleness window (default: 45 days). |
| `NEVER USED` | Installed older than grace period (default: 7 days) with zero usage evidence. |
| `MODEL VISIBLE` | Active skill whose description is actively exposed to the model context. |
| `HIDDEN` | System/internal skill or disabled description not loaded into default prompt. |
| `DUPLICATE` | Identical skill installed across multiple agent roots. |
| `BROKEN` | Broken symlinks or missing `SKILL.md` entry points. |

*(Automated `KEEP / HIDE / REMOVE` recommendations will be introduced in v0.2).*

---

## Configuration & State Isolation

`skill-context-doctor` uses completely independent directories to prevent interference with other tools:

- **Configuration**: `~/.config/skill-context-doctor/` (e.g. `omit` filter rules)
- **Runtime State & Cache**: `~/.local/state/skill-context-doctor/` (`scan-cache-v1.json`, `runs/` quarantine manifests)
- **Temporary Files**: `/tmp/skill-context-doctor-rg-*.txt`

---

## Supported Agents & Signal Sources

| Agent | History Locations | Usage Evidence | Mention Evidence |
| --- | --- | --- | --- |
| **Pi** | `~/.pi/agent/sessions` | Explicit `/skill:name` invocations; structured `read` tool calls; shell commands reading installed `SKILL.md` | Raw installed `SKILL.md` path references |
| **Codex** | `~/.codex/history.jsonl`, `~/.codex/sessions` | Structured `read_skill`, `skill`, or `read` tool calls; shell commands reading `SKILL.md` | Raw `SKILL.md` path references |
| **Claude / Claude Code** | `~/.claude/history.jsonl`, `~/.claude/projects`, `~/.claude/tasks`, `~/.claude/sessions` | `attributionSkill` records; native `Skill` tool calls; slash-command skill tags; structured `read` tool calls; shell commands reading `SKILL.md` | Raw `SKILL.md` path references |
| **OpenCode** | `~/.local/share/opencode/storage` | Structured `read` tool parts targeting installed `SKILL.md` | Raw `SKILL.md` path references in storage JSON |
| **Cursor** | `~/.cursor/projects/**/agent-transcripts/*.jsonl`, `~/.cursor/chats/**/store.db` | Structured read tool calls in agent transcripts targeting installed `SKILL.md` | Raw `SKILL.md` path references in transcripts or DB blobs |

---

## Project Roadmap

```text
v0.1 Audit (Current)
  │  ├── Multi-agent discovery (Claude, Codex, Pi, OpenCode, Cursor)
  │  ├── Verified usage evidence vs mentions
  │  ├── Context token overhead measurement
  │  ├── Duplicate & symlink detection
  │  └── Safe quarantine & undo
  │
  ▼
v0.2 Recommend
  │  ├── Fact-based recommendations: KEEP / HIDE / REMOVE
  │  ├── Health score & risk evaluation
  │  └── Interactive rule generation
  │
  ▼
v0.3 Optimize
  │  ├── Dynamic context budgeting
  │  ├── Lazy skill loading & description trimming
  │  └── System prompt compression
  │
  ▼
v0.4 Cross-Agent Governance
     ├── Unified skill manifest across agents
     ├── Symlink orchestration
     └── Version & drift sync
```

---

## Attribution & License

Originally derived from [vltansky/skillkill](https://github.com/vltansky/skillkill).

- Copyright (c) 2026 skillkill contributors
- Copyright (c) 2026 yang2020chen

Licensed under the [MIT License](LICENSE).
