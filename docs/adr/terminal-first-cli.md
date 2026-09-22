# ADR: Build `skillkill` as a terminal-first cleanup CLI

## Status

Proposed

## Context

The initial skill usage audit workflow grew from a skill-specific script into an
Agents UI review flow. That added useful visualization, but it also added too
much surface area for a local maintenance task.

The desired workflow is closer to existing cleanup CLIs for stale local files,
caches, and worktrees:

- Run a command.
- Review candidates in the terminal.
- Optionally export data.
- Apply cleanup only through an explicit flag.

Prior art points in the same direction:

- Git `clean` separates preview from deletion with `--dry-run` and `--force`.
- pip exposes cache cleanup as terminal verbs and reports removal totals.
- pnpm exposes store pruning as a direct CLI maintenance action.
- `npkill` is a focused developer-artifact cleaner: it scans for
  `node_modules`, shows size and context, supports deletion from the terminal,
  and exposes JSON output.
- `killpy` applies a similar shape to Python environments, with both TUI and
  headless command modes.
- `dwipe`, `mac-cleaner-cli`, and `null-e` show useful safety ideas such as
  two-step deletion, trash mode, risk tiers, and category selection.

The research conclusion is that `skillkill` should be "npkill for installed
agent skills": narrow artifact class, clear evidence, interactive terminal
review, reversible apply. It should not start as a broad developer disk cleaner.

## Decision

Build `skillkill` as a terminal-first CLI project under
`~/projects/skillkill`.

The CLI will:

- Scan local installed agent skills.
- Use Codex, Claude, OpenCode, Cursor, and explicit local filesystem evidence
  roots by default where safe local stores are known.
- Treat Codex injected skill blocks and Claude `attributionSkill` as usage
  evidence.
- Treat structured read tool calls and captured shell commands that read an
  installed `SKILL.md` as usage evidence.
- Treat OpenCode message paths, Cursor chat-store paths, Cursor transcript
  path mentions that are not structured reads, explicit `--evidence-dir` path
  matches that are not structured reads or read commands, `atime`, and raw path
  mentions as lower-confidence mention evidence.
- Defer cleanup for skills with recent mentions, while keeping that evidence
  labeled as lower confidence than native provider attribution.
- Open an interactive terminal review by default when stdin/stdout are terminals.
- Print a static dry-run candidate table when output is piped or
  `--no-interactive` is passed.
- Put cleanup candidates first.
- Omit user-whitelisted skills from cleanup candidates.
- Require `--apply` for cleanup.
- Move applied candidates into a local quarantine run with an undo manifest.
- Support `--undo latest` to restore the most recent cleanup run.
- Support `--omit`, `--whitelist`, `--omit-file`, and a default persistent
  omit file at `~/.config/skillkill/omit`.
- Support `--commands`, `--json`, `--csv`, and `--snapshot`.
- Support `--source opencode`, `--source cursor`, `--source filesystem`,
  `--evidence-dir`, and `--protect-mention-days`.
- Stay scoped to whole skill directories, not files inside a skill.
- Treat richer TUI search/filter and risk-tier features as later improvements.

The CLI will not serve Agents UI or generate an interactive browser review.
The CLI will not clean unrelated developer artifacts such as `node_modules`,
virtualenvs, build caches, Docker data, or Xcode data.

## Consequences

Positive:

- The workflow is simpler and easier to run repeatedly.
- The cleanup path is explicit and reversible.
- The output works for both humans and automation.
- The implementation can stay dependency-light.
- The product has a clear reference class: `npkill`, but for agent skills.

Negative:

- Review decisions are simpler than the Agents UI version.
- Search and filter are not available in the first interactive version.
- Automation must use table, command, CSV, JSON, or snapshot output.
- Omit patterns can hide stale skills that might still be useful.
- The narrow scope means it will not solve broader local disk cleanup problems.

## Alternatives Considered

### Keep Agents UI Review

Rejected for the default workflow. It is richer, but too heavy for routine local
cleanup and introduces a server/browser lifecycle.

### Keep As An Installed Skill Script Only

Rejected. The maintenance behavior should live in a normal project with a
normal CLI entrypoint, not inside a skill directory.

### Delete Automatically During Scan

Rejected. Cleanup candidates are recommendations, not proof that deletion is
safe for every future workflow.

### Permanently Delete On Apply

Rejected. `--apply` should be undoable by default. Permanent deletion can be a
future purge operation for old quarantine runs.

### Build A Static Table First

Rejected as the default experience. `npkill`, `killpy`, and `dwipe` show that
interactive terminal review is central to this product class. Static table,
JSON, CSV, and command output remain available for scripts and pipes.

### Build A Broad Developer Cleaner

Rejected for this project. Tools like `mac-cleaner-cli` and `null-e` show a
broader category-based cleanup direction, but `skillkill` should stay
focused on installed agent skills.

## Follow-Ups

- Move or rewrite the current scanner into this project.
- Split scanner, row-building, output formatting, and deletion into small
  modules.
- Add fixture tests for Codex skill blocks, Claude `attributionSkill`,
  mentions, never-used skills, and protected dot-prefixed skills.
- Implement the first-release command surface from `docs/plan.md`.
- Link `$HOME/.local/bin/skillkill` to the project entrypoint.
- Update the old installed skill doc to delegate to this CLI.
- Revisit `--include`, `--exclude`, quarantine retention, search/filter, and
  risk tiers after the first release.
