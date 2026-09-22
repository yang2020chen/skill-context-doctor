# skill-context-doctor Agent Notes

## Project Shape

- `skill-context-doctor` is a terminal-first CLI for auditing agent skill usage, context overhead, stale skills, duplicates, and broken installations.
- Keep cleanup scoped to whole installed skill directories. Do not expand this project into a general disk cleaner.
- Historically derived from `vltansky/skillkill`.

## Evidence Model

- Treat evidence classification as product behavior, not implementation detail.
- Usage evidence: native skill invocation metadata (e.g. `/skill:name`), structured tool/read calls targeting an installed `SKILL.md`, and captured shell commands that read an installed `SKILL.md` from trusted transcripts.
- Mention evidence: raw path/name references, filesystem `atime`, Cursor chat DB blob matches, and closed or undocumented stores without a stable parsed schema.
- Mentions may protect a skill from cleanup, but must not drive `last_used`, `last_verified_use`, or verified-use claims.
- Keep `usage`, `mention`, `last_used`, `last_seen`, and `last_any_signal` semantically separate in code, tests, docs, and output copy.

## CLI Behavior

- Bare `skill-context-doctor --undo` and `skill-context-doctor undo` open the interactive restore picker.
- `skill-context-doctor --undo latest`, `skill-context-doctor undo latest`, `--undo RUN_ID`, and `--undo PATH` remain direct/scriptable restore paths.
- Interactive mode only auto-enables when stdin and stdout are terminals and no non-interactive output flag conflicts with it.
- State directory: `~/.local/state/skill-context-doctor/`.
- Config directory: `~/.config/skill-context-doctor/`.
- Omit/whitelist patterns are persistent, auditable cleanup exclusions. Preserve omit reasons in machine-readable output.

## Testing And Release Notes

- Evidence changes need fixture tests across agents: Codex, Claude, Pi, OpenCode, and Cursor; indirect invocation, direct `SKILL.md` read, and path-link mention.
- The default branch is `main`.
