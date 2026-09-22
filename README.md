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
# Run unified health & context overhead audit
npx skill-context-doctor audit

# Open interactive skill review
npx skill-context-doctor
```

Or install globally:

```bash
npm install --global skill-context-doctor
skill-context-doctor audit
```

### Health Audit Report (`audit`)

`skill-context-doctor audit` provides an objective, unified health report and ranks top context consumers:

```text
Skill Context Doctor

Evidence sources detected: Pi, Claude Code, Codex, OpenCode

Skills & Installation Health
  Skills discovered         107
  Installations             125
  Model-visible              16
  Actually used              22
    ↳ Stale (idle >45d)       7
  Never used                 85
  Duplicate groups            9 (18 extra copies)
  Broken installations        2

Estimated Context Overhead
  Visible skill metadata    ~3.0K tokens (3,007 tokens)

Usage Sources Breakdown
  Pi                22 skills (91 events)
  Claude Code        5 skills (14 events)

Top Context Consumers (Model-Visible)

Skill                            Visible Tokens    Usage   Last Used
------------------------------   --------------   ------   ----------------
hyperframes-registry                        223          0   -
hyperframes                                 198          4   2026-09-18 16:04
talking-head-recut                          113          2   2026-09-18 16:00
faceless-explainer                           97          1   2026-07-20 09:57
github-ops                                   82          0   -
```

### Actionable Recommendations (`recommend`)

`skill-context-doctor recommend` translates audit facts into explainable, deterministic recommendations with zero guesswork. Recommendations are advisory and non-destructive:

```bash
skill-context-doctor recommend
```

```text
Skill Context Doctor

Skill Context Doctor - Recommendations (v0.2.0)
Analysis Scope: all evidence sources

Summary
  KEEP                  42  (Recently used or system skills)
  HIDE                  18  (Model-visible but unused or stale)
    ↳ Potential visible context savings: ~3.2K tokens (3,180 tokens)
  REVIEW                12  (Broken, cross-agent, duplicate, or stale)
  REMOVE CANDIDATE      35  (Already hidden from model and never used)

Highest Impact HIDE Candidates (Reclaim Context Overhead)

Skill                            Visible Tokens   Confidence   Reasons
------------------------------   --------------   ----------   ----------------------------------------
hyperframes-registry                        223   high         MODEL_VISIBLE, NEVER_USED, HIGH_CONTEXT_COST
github-ops                                   82   high         MODEL_VISIBLE, NEVER_USED
faceless-explainer                           97   medium       MODEL_VISIBLE, STALE_USAGE, CONTEXT_OVERHEAD

Items Requiring Human Review

Skill                            Primary Reason                Explanation
------------------------------   ---------------------------   ----------------------------------------
broken-tool                      BROKEN_INSTALLATION           Broken symlink or missing SKILL.md definition
popular-cross-tool               CROSS_AGENT_SHARED            Shared across multiple agents (pi, claude)
...
```

### Safe Context Optimization (`optimize`)

`skill-context-doctor optimize` safely executes the `HIDE` recommendations by setting `disable-model-invocation: true` in `SKILL.md` frontmatter.
- **Dry-run by default**: previews planned modifications, token savings, and keep protections without touching disk.
- **Zero file deletions**: only sets frontmatter disable flags; skills remain installed and manually invocable (e.g. `/skill:name`).
- **Two-phase transaction**: creates byte-exact backups before writing, verifies hashes before modifying, and automatically rolls back if any write fails.
- **Safe undo**: `skill-context-doctor undo latest` restores files byte-for-byte, refusing to overwrite manual edits made after optimization.

```bash
# Preview planned context optimization (dry-run)
skill-context-doctor optimize

# Execute context optimization
skill-context-doctor optimize --apply

# Protect specific skills from being hidden
skill-context-doctor optimize --keep xlsx --keep video-translation

# Protect skills via persistent keep file (~/.config/skill-context-doctor/keep)
echo "my-custom-skill" >> ~/.config/skill-context-doctor/keep
skill-context-doctor optimize

# Revert the latest optimization run
skill-context-doctor undo latest
```

```text
Skill Context Doctor

Skill Context Doctor - Optimize (Dry Run)
Target: Hide model-visible skills that are unused or heavy stale

Planned Actions (HIDE)
  Skills to hide:        87
  Estimated savings:     ~6.2K tokens (6,218 tokens)
  Protected by --keep:   2
  Skipped (review/dup):  142

High Impact Skills to Hide:

Skill                            Visible Tokens   Confidence   Reasons
------------------------------   --------------   ----------   ----------------------------------------
docx                                        197   medium       MODEL_VISIBLE, STALE_USAGE, CONTEXT_OVERHEAD
talking-head-guide                          195   high         MODEL_VISIBLE, NEVER_USED, HIGH_CONTEXT_COST
digital-human                               187   high         MODEL_VISIBLE, NEVER_USED, HIGH_CONTEXT_COST
product-help                                175   high         MODEL_VISIBLE, NEVER_USED, HIGH_CONTEXT_COST
pptx                                        174   high         MODEL_VISIBLE, NEVER_USED, HIGH_CONTEXT_COST
voice                                       149   medium       MODEL_VISIBLE, STALE_USAGE, CONTEXT_OVERHEAD

Removal Candidates (Manual Review)
  21 removal candidates available (already hidden & never used).
  Use `skill-context-doctor cleanup` to review and quarantine them.

No files changed. Run with --apply to execute.
```

### Common Commands

```bash
# Safe context optimization (dry-run)
skill-context-doctor optimize
skill-context-doctor optimize --apply
skill-context-doctor optimize --keep my-skill
skill-context-doctor undo latest

# Actionable recommendations
skill-context-doctor recommend
skill-context-doctor recommend --json

# Unified health & context overhead audit
skill-context-doctor audit
skill-context-doctor audit --json
skill-context-doctor audit --source pi

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

# Exclude trusted skills from cleanup review
skill-context-doctor --omit "my-special-skill"
skill-context-doctor omit "ck-*"

# Quarantine candidates and restore
skill-context-doctor cleanup --apply
skill-context-doctor undo latest
```

---

## Recommendation Classification (v0.2)

`skill-context-doctor recommend` evaluates skills against a strict 11-step deterministic hierarchy:

| Recommendation | Criteria | Rationale |
| --- | --- | --- |
| `KEEP` | Verified usage within stale window (≤45d) or system/internal (`.dot` prefix). | Protect active workflows and critical core agent functions. |
| `HIDE` | Model-visible with zero usage, or stale (>45d) with significant token cost (≥50 tokens). | Reclaim input context tokens by disabling model invocation (`disable-model-invocation: true`). Leaves files untouched. |
| `REVIEW` | Broken links, cross-agent shared tools, duplicate installs across roots, recent mentions without execution, or general stale tools. | Flags ambiguity for human review before any action. |
| `REMOVE CANDIDATE` | Already hidden from model invocation AND zero usage evidence AND no recent mentions. | Safe candidate for file deletion or uninstallation (`cleanup --apply`). |

> [!NOTE]
> Recommendations are computed across global multi-agent evidence. When filtering with `--source pi`, decisions remain global to avoid falsely flagging cross-agent skills. Token savings strictly count `HIDE` candidates, as `REMOVE CANDIDATE` items are already hidden from model prompts.

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
v0.1 Audit (Completed)
  │  ├── Multi-agent discovery (Claude, Codex, Pi, OpenCode, Cursor)
  │  ├── Verified usage evidence vs mentions
  │  ├── Context token overhead measurement
  │  ├── Duplicate & symlink detection
  │  └── Safe quarantine & undo
  │
  ▼
v0.2 Recommend (Completed)
  │  ├── Deterministic recommendations: KEEP / HIDE / REVIEW / REMOVE CANDIDATE
  │  ├── 11-step rule hierarchy built directly on audit facts
  │  ├── Context token savings estimation for HIDE candidates
  │  ├── Cross-agent safe scoping
  │  └── Structured JSON report (`recommend --json`)
  │
  ▼
v0.3 Optimize (Completed)
  │  ├── Two-phase transactional execution (`optimize --apply`)
  │  ├── Immutable manifest & byte-exact backups
  │  ├── Conservative frontmatter patching (`disable-model-invocation: true`)
  │  ├── Exact-name keep whitelist (`--keep` and keep file)
  │  ├── Canonical target multi-identity conflict protection
  │  └── Hash-guarded safe undo against user post-optimize edits
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
