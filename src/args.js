import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { renderLogo } from "./logo.js";

export const DEFAULT_SKILLS_DIRS = [
  "~/.agents/skills",
  "~/.claude/skills",
  "~/.codex/skills",
  "~/.cursor/skills",
  "~/.pi/agent/skills",
];

export const DEFAULT_OPTIONS = {
  command: "",
  commandArgs: [],
  skillsDir: DEFAULT_SKILLS_DIRS[0],
  skillsDirs: DEFAULT_SKILLS_DIRS,
  codexDir: "~/.codex",
  claudeDir: "~/.claude",
  claudeAppDir: "~/Library/Application Support/Claude",
  opencodeDir: "~/.local/share/opencode",
  cursorDir: "~/.cursor/chats",
  piDir: "~/.pi/agent",
  evidenceDirs: [],
  source: "all",
  unusedDays: 45,
  unusedInstalledDays: 7,
  protectMentionDays: 45,
  protectWeakDays: 45,
  savingsDays: 30,
  limit: 40,
  fullScan: false,
  cache: true,
  json: false,
  csv: "",
  snapshot: "",
  stateDir: "~/.local/state/skill-context-doctor",
  omitPatterns: [],
  omitFile: "~/.config/skill-context-doctor/omit",
  noOmitFile: false,
  commands: false,
  interactive: false,
  noInteractive: false,
  apply: false,
  undo: "",
};

export const INTERACTIVE_UNDO = "__interactive_undo__";
const COMMANDS = new Set(["list", "cleanup", "omit", "undo", "audit"]);

export function expandHome(value, home = os.homedir()) {
  if (!value) return value;
  if (value === "~") return home;
  return value.startsWith("~/") ? path.join(home, value.slice(2)) : value;
}

function readNext(argv, index, arg) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${arg} requires a value`);
  }
  return value;
}

function readOptionalNext(argv, index) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) return "";
  return value;
}

function readNumber(argv, index, arg) {
  const value = Number(readNext(argv, index, arg));
  if (Number.isNaN(value) || value < 0) {
    throw new Error(`${arg} must be a non-negative number`);
  }
  return value;
}

function walkSkillRootEntries(root, out = new Set()) {
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === "skills") {
      out.add(fullPath);
      continue;
    }
    walkSkillRootEntries(fullPath, out);
  }
  return out;
}

function codexPluginSkillRoots(codexDir) {
  return [...walkSkillRootEntries(path.join(codexDir, "plugins", "cache"))];
}

export function printHelp() {
  return `${renderLogo()}

Usage: skill-context-doctor [command] [options]

Commands:
  audit                          Generate unified health & context overhead report
  list                           Scan skills and print the normal report
  cleanup                        Scan skills, optionally with --apply
  omit <skill-or-pattern>         Add persistent omit patterns
  undo [latest|RUN_ID|PATH]       Restore a previous cleanup run

Options:
  --path PATH                     Skills directory to scan; repeatable
  --skills-dir PATH               Alias for --path
  --source codex|claude|opencode|cursor|filesystem|pi|all
                                  Evidence source to scan (default: all)
  --codex-dir PATH                Codex state directory (default: ~/.codex)
  --claude-dir PATH               Claude state directory (default: ~/.claude)
  --claude-app-dir PATH           Claude desktop state directory
  --opencode-dir PATH             OpenCode state directory (default: ~/.local/share/opencode)
  --cursor-dir PATH               Cursor chats directory, or ~/.cursor root (default: ~/.cursor/chats)
  --pi-dir PATH                   PI agent directory (default: ~/.pi/agent)
  --evidence-dir PATH             Extra local transcript/log directory to scan for mentions
  --unused-days N                 Mark skills stale after last use (default: 45)
  --unused-installed-days N       Propose never-used skills older than N days (default: 7)
  --protect-mention-days N        Defer cleanup after recent mentions (default: 45)
  --protect-weak-days N           Deprecated alias for --protect-mention-days
  --savings-days N                Estimate token effect from recent activity (default: 30)
  --limit N                       Table row limit (default: 40)
  --commands                      Print all candidate rm commands
  --json                          Print JSON payload to stdout
  --csv PATH                      Write CSV rows
  --snapshot PATH                 Append a JSONL snapshot
  --state-dir PATH                Cleanup state directory (default: ~/.local/state/skill-context-doctor)
  --omit PATTERN                  Omit skill name/path from cleanup candidates
  --whitelist PATTERN             Alias for --omit
  --allowlist PATTERN             Alias for --omit
  --omit-file PATH                Omit file (default: ~/.config/skill-context-doctor/omit)
  --no-omit-file                  Ignore the default omit file
  --interactive                   Force interactive terminal review
  --no-interactive                Print the static table instead of terminal review
  --apply                         Move cleanup candidates to quarantine
  --undo [latest|RUN_ID|PATH]     Restore a previous cleanup run
  --full-scan                     Parse every JSONL line instead of using ripgrep prefilter
  --no-cache                      Bypass incremental scan evidence for this run
  -h, --help                      Show help

Default skill roots are ~/.agents/skills, ~/.claude/skills, ~/.codex/skills, ~/.cursor/skills, and ~/.pi/agent/skills.
Default behavior is interactive when stdin/stdout are terminals, otherwise static dry-run.
--apply writes an undo manifest; restore interactively with --undo or directly with --undo latest.
Direct forms are also available: skill-context-doctor list --json, skill-context-doctor cleanup --apply,
skill-context-doctor omit simplify, skill-context-doctor undo latest.
`;
}

export function parseArgs(argv) {
  const options = {
    ...DEFAULT_OPTIONS,
    commandArgs: [...DEFAULT_OPTIONS.commandArgs],
    skillsDirs: [...DEFAULT_OPTIONS.skillsDirs],
    evidenceDirs: [...DEFAULT_OPTIONS.evidenceDirs],
    omitPatterns: [...DEFAULT_OPTIONS.omitPatterns],
  };
  let customSkillsDirs = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("-")) {
      if (!options.command && COMMANDS.has(arg)) {
        options.command = arg;
      } else if (options.command === "omit" || options.command === "undo") {
        options.commandArgs.push(arg);
      } else {
        throw new Error(`Unknown command or option: ${arg}`);
      }
    } else if (arg === "--path" || arg === "--skills-dir") {
      if (!customSkillsDirs) {
        options.skillsDirs = [];
        customSkillsDirs = true;
      }
      options.skillsDirs.push(readNext(argv, i, arg));
      i += 1;
    } else if (arg === "--source") {
      options.source = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--codex-dir") {
      options.codexDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--claude-dir") {
      options.claudeDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--claude-app-dir") {
      options.claudeAppDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--opencode-dir") {
      options.opencodeDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--cursor-dir") {
      options.cursorDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--pi-dir") {
      options.piDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--evidence-dir") {
      options.evidenceDirs.push(readNext(argv, i, arg));
      i += 1;
    } else if (arg === "--unused-days") {
      options.unusedDays = readNumber(argv, i, arg);
      i += 1;
    } else if (arg === "--unused-installed-days") {
      options.unusedInstalledDays = readNumber(argv, i, arg);
      i += 1;
    } else if (arg === "--protect-mention-days" || arg === "--protect-weak-days") {
      options.protectMentionDays = readNumber(argv, i, arg);
      options.protectWeakDays = options.protectMentionDays;
      i += 1;
    } else if (arg === "--savings-days") {
      options.savingsDays = readNumber(argv, i, arg);
      i += 1;
    } else if (arg === "--limit") {
      options.limit = readNumber(argv, i, arg);
      i += 1;
    } else if (arg === "--csv") {
      options.csv = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--snapshot") {
      options.snapshot = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--state-dir") {
      options.stateDir = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--omit" || arg === "--whitelist" || arg === "--allowlist") {
      options.omitPatterns.push(readNext(argv, i, arg));
      i += 1;
    } else if (arg === "--omit-file") {
      options.omitFile = readNext(argv, i, arg);
      i += 1;
    } else if (arg === "--no-omit-file") {
      options.noOmitFile = true;
    } else if (arg === "--commands") {
      options.commands = true;
    } else if (arg === "--interactive") {
      options.interactive = true;
    } else if (arg === "--no-interactive") {
      options.noInteractive = true;
    } else if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--undo") {
      const value = readOptionalNext(argv, i);
      options.undo = value || INTERACTIVE_UNDO;
      if (value) i += 1;
    } else if (arg === "--full-scan") {
      options.fullScan = true;
    } else if (arg === "--no-cache") {
      options.cache = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (options.command === "undo") {
    if (options.undo && options.commandArgs.length > 0) {
      throw new Error("skill-context-doctor undo cannot be combined with --undo");
    }
    if (options.commandArgs.length > 1) {
      throw new Error("skill-context-doctor undo accepts at most one target");
    }
    options.undo = options.commandArgs[0] || options.undo || INTERACTIVE_UNDO;
  }
  if (options.command === "omit") {
    if (options.commandArgs.length === 0) {
      throw new Error("skill-context-doctor omit requires at least one skill or pattern");
    }
    if (options.noOmitFile) {
      throw new Error("skill-context-doctor omit writes to the omit file; remove --no-omit-file");
    }
    if (options.apply || options.undo || options.commands || options.json || options.csv || options.snapshot) {
      throw new Error("skill-context-doctor omit cannot be combined with scan/output/apply options");
    }
  }
  if (options.command === "list" && options.apply) {
    throw new Error("skill-context-doctor list cannot be combined with --apply");
  }
  if (options.command === "audit" && options.apply) {
    throw new Error("skill-context-doctor audit cannot be combined with --apply");
  }

  if (!["codex", "claude", "opencode", "cursor", "filesystem", "pi", "all"].includes(options.source)) {
    throw new Error("--source must be codex, claude, opencode, cursor, filesystem, pi, or all");
  }
  if (options.apply && options.json) {
    throw new Error("--apply cannot be combined with --json");
  }
  if (options.apply && options.commands) {
    throw new Error("--apply cannot be combined with --commands");
  }
  if (options.interactive && options.noInteractive) {
    throw new Error("--interactive cannot be combined with --no-interactive");
  }
  if (options.interactive && (options.apply || options.commands || options.json)) {
    throw new Error("--interactive cannot be combined with --apply, --commands, or --json");
  }
  if (options.undo && (options.apply || options.commands || options.json || options.csv || options.snapshot)) {
    throw new Error("--undo cannot be combined with scan/output/apply options");
  }

  const configuredSkillsDirs = [
    ...new Set(
      options.skillsDirs
        .flatMap((value) =>
          value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        )
        .map((item) => path.resolve(expandHome(item))),
    ),
  ];
  const codexDir = path.resolve(expandHome(options.codexDir));
  const defaultSkillsDirs = DEFAULT_OPTIONS.skillsDirs.map((item) =>
    path.resolve(expandHome(item)),
  );
  const usingDefaultSkillDirs =
    configuredSkillsDirs.length === defaultSkillsDirs.length &&
    configuredSkillsDirs.every((item, index) => item === defaultSkillsDirs[index]);
  const skillsDirs = usingDefaultSkillDirs
    ? [...new Set([...configuredSkillsDirs, ...codexPluginSkillRoots(codexDir)])]
    : configuredSkillsDirs;

  return {
    ...options,
    commandArgs: options.commandArgs,
    skillsDir: skillsDirs[0],
    skillsDirs,
    codexDir,
    claudeDir: path.resolve(expandHome(options.claudeDir)),
    claudeAppDir: path.resolve(expandHome(options.claudeAppDir)),
    opencodeDir: path.resolve(expandHome(options.opencodeDir)),
    cursorDir: path.resolve(expandHome(options.cursorDir)),
    piDir: path.resolve(expandHome(options.piDir)),
    evidenceDirs: options.evidenceDirs.flatMap((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => path.resolve(expandHome(item))),
    ),
    csv: options.csv ? path.resolve(expandHome(options.csv)) : "",
    snapshot: options.snapshot ? path.resolve(expandHome(options.snapshot)) : "",
    stateDir: path.resolve(expandHome(options.stateDir)),
    omitFile: path.resolve(expandHome(options.omitFile)),
    omitPatterns: options.omitPatterns.flatMap((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
    undo:
      options.undo &&
      options.undo !== INTERACTIVE_UNDO &&
      (options.undo.includes("/") || options.undo.startsWith("~"))
        ? path.resolve(expandHome(options.undo))
        : options.undo,
  };
}
