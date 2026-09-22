# skill-context-doctor

> **Audit real Agent Skill usage, context cost, duplication, and safely optimize overhead.**

```text
发现问题 (audit) → 给建议 (recommend) → 安全优化 (optimize) → 可以撤销 (undo)
```

You installed dozens or hundreds of Agent Skills.
- Which ones are **actually used**?
- Which ones **silently consume system prompt tokens** on every single turn?
- Which ones are **stale, duplicated, or broken**?

`skill-context-doctor` audits local agent skills across **Claude Code**, **Codex**, **Pi**, **OpenCode**, and **Cursor** by inspecting actual transcripts and execution history rather than guessing.

---

## 📦 Installation & Quick Start

Run instantly without installation via `npx`:

```bash
# 1. Audit skill health and context token overhead
npx skill-context-doctor audit

# 2. View actionable optimization recommendations
npx skill-context-doctor recommend

# 3. Preview safe context optimization (dry-run)
npx skill-context-doctor optimize
```

Or install globally:

```bash
npm install -g skill-context-doctor

skill-context-doctor audit
```

---

## 🚀 The 3 Core Commands

### 1. `audit` — Unified Health & Context Overhead Report

Scans installed skills across all agent directories and checks local session logs for verified usage evidence (slash commands, tool calls, file reads).

```bash
skill-context-doctor audit
```

Example Output:
```text
Skill Context Doctor

Evidence sources detected: Pi, Claude Code, Codex, OpenCode

Skills & Installation Health
  Skills discovered         207
  Installations             316
  Model-visible             137
  Actually used             88
    ↳ Stale (idle >45d)      40
  Never used                119
  Duplicate groups          51 (109 extra copies)
  Broken installations      1

Estimated Context Overhead
  Visible skill metadata    ~10.8K tokens (10,827 tokens)

Usage Sources Breakdown
  Pi                22 skills (120 events)
  Claude Code        7 skills (25 events)
  Codex             75 skills (1,937 events)

Top Context Consumers (Model-Visible)

Skill                            Visible Tokens    Usage   Last Used       
------------------------------   --------------   ------   ----------------
xlsx                                        236          0   -               
hyperframes-registry                        223          1   2026-09-03 12:19
video-translation                           206          0   -               
hyperframes                                 198         74   2026-09-18 16:04
docx                                        197          1   2026-04-21 04:03
talking-head-guide                          195          0   -               
```

Useful flags:
```bash
skill-context-doctor audit --json              # Output structured JSON
skill-context-doctor audit --source claude     # Inspect Claude usage only
skill-context-doctor audit --path ~/.my-skills # Add custom skills directory
```

---

### 2. `recommend` — Actionable Decision Engine

Evaluates every skill against an 11-step deterministic rule hierarchy, categorizing each into one of four clear actions:

| Action | Meaning & Criteria | Safe Execution |
|---|---|---|
| `KEEP` | Verified recent usage (≤45d) or system/internal (`.dot` prefix). | Protected from any changes. |
| `HIDE` | Model-visible but never used (≥7d) or stale with significant context cost (≥50 tokens). | Reclaim context tokens by adding `disable-model-invocation: true`. Leaves skill files untouched. |
| `REVIEW` | Cross-agent shared, broken symlink, duplicate install across roots, or recent mention without run. | Human review required; never modified automatically. |
| `REMOVE CANDIDATE` | Already hidden from prompt AND never used. | Eligible for reversible quarantine with `cleanup`. |

```bash
skill-context-doctor recommend
```

Useful flags:
```bash
skill-context-doctor recommend --json          # Machine-readable recommendation payload
```

---

### 3. `optimize` & `undo` — Safe Context Reduction with Instant Restore

`optimize` safely applies `HIDE` recommendations by setting `disable-model-invocation: true` in `SKILL.md` frontmatter.

#### Safety Contracts:
- **Default Dry-Run**: Running `optimize` never modifies files without `--apply`.
- **Two-Phase Atomic Write**: Writes to a temp file on the same filesystem, syncs to disk (`fsync`), then renames atomically.
- **Pre-Write Hash Verification**: Compares SHA-256 immediately before write to prevent race conditions or overwriting user edits.
- **Canonical Target Conflict Protection**: If multiple skills or symlinks resolve to the same target file, all identities must agree on `HIDE`; otherwise skips modification.
- **Byte-Exact Undo**: Backups are saved to `~/.local/state/skill-context-doctor/runs/<RUN_ID>/backups/`. Running `undo latest` restores the original content byte-for-byte with file permissions preserved.
- **Anti-Tamper Guard**: If a user manually edited the file after optimization, `undo` refuses to overwrite with `CONFLICT_AFTER_OPTIMIZE`.

```bash
# Preview changes (Dry Run)
skill-context-doctor optimize

# Trial on a single skill
skill-context-doctor optimize --apply --only xlsx

# Batch optimize with a limit
skill-context-doctor optimize --apply --limit 5

# Protect specific skills from optimization
skill-context-doctor optimize --apply --keep my-skill

# Undo the last optimization run
skill-context-doctor undo latest
```

### Optional: reversible cleanup of removal candidates

`cleanup` only quarantines skills classified as `REMOVE CANDIDATE`: they must already be hidden from model invocation, have no verified usage, and have no recent mention. It never removes an active model-visible skill. Each move is recorded before it happens, so `undo latest` can recover an interrupted cleanup run as well.

```bash
skill-context-doctor cleanup
skill-context-doctor cleanup --apply
```

---

## 🛠️ Supported Agents & Signal Sources

| Agent | History Scanned | Usage Evidence Signals |
| --- | --- | --- |
| **Pi** | `~/.pi/agent/sessions` | Explicit `/skill:name` invocations; structured `read` tool calls; shell commands reading `SKILL.md` |
| **Claude / Claude Code** | `~/.claude/history.jsonl`, `~/.claude/projects`, `~/.claude/tasks`, `~/.claude/sessions` | `attributionSkill` records; native `Skill` tool calls; slash-command skill tags; structured `read` tool calls |
| **Codex** | `~/.codex/history.jsonl`, `~/.codex/sessions` | Structured `read_skill`, `skill`, or `read` tool calls; shell commands reading `SKILL.md` |
| **OpenCode** | `~/.local/share/opencode/storage` | Structured `read` tool calls targeting installed `SKILL.md` |
| **Cursor** | `~/.cursor/projects/**/agent-transcripts/*.jsonl`, `~/.cursor/chats/**/store.db` | Structured read tool calls in agent transcripts targeting installed `SKILL.md` |

---

## 📁 Configuration & State Storage

`skill-context-doctor` never litters your project or home directory:

- **Config**: `~/.config/skill-context-doctor/` (`keep` whitelist, `omit` patterns)
- **State & Backups**: `~/.local/state/skill-context-doctor/` (`scan-cache-v1.json`, `runs/<RUN_ID>/`)
- **Temp Files**: Cleaned up automatically upon exit

---

## 📌 Project Status

**v0.3.x — Feature Complete & Maintenance Mode.**

The core lifecycle loop is fully closed:
> **发现问题 (`audit`) → 给建议 (`recommend`) → 安全优化 (`optimize`) → 可以撤销 (`undo`)**

Scope is intentionally frozen. No speculative multi-agent management platforms or complex abstractions will be added. New features will only be considered based on real user issues or concrete personal workflow bottlenecks.

---

## 📄 License

Originally derived from [vltansky/skillkill](https://github.com/vltansky/skillkill).

- Copyright (c) 2026 skillkill contributors
- Copyright (c) 2026 yang2020chen

Licensed under the [MIT License](LICENSE).
