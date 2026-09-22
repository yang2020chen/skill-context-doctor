import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../src/app.js";
import { parseArgs } from "../src/args.js";
import { formatCleanupResult } from "../src/cleanup-result.js";
import { formatNumber } from "../src/format.js";
import {
  renderInteractiveLoadingScreen,
  renderInteractiveScreen,
  shouldRunInteractive,
} from "../src/interactive.js";
import { buildRows } from "../src/model.js";
import { loadOmitPatterns } from "../src/omit.js";
import { collectSkills, scanEvidence } from "../src/scan.js";
import { scanSkillsInWorker } from "../src/scan-worker.js";
import { quarantineCandidates } from "../src/quarantine.js";
import { renderInteractiveUndoScreen } from "../src/undo-interactive.js";
import { formatCommands, formatTable } from "../src/output.js";
import { renderLogo } from "../src/logo.js";

const NOW = new Date("2026-06-15T00:00:00Z");

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;
  resumed = false;
  paused = false;

  setRawMode(value) {
    this.isRaw = value;
  }

  resume() {
    this.resumed = true;
  }

  pause() {
    this.paused = true;
  }
}

class FakeStdout {
  isTTY = true;
  columns = 120;
  rows = 24;
  output = "";

  write(chunk) {
    this.output += chunk;
  }
}

function press(stdin, name, value = name) {
  stdin.emit("keypress", value, { name });
}

async function waitForOutput(stdout, pattern) {
  const deadline = Date.now() + 1000;
  while (!pattern.test(stdout.output)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for output: ${pattern}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-context-doctor-test-"));
  const skillsDir = path.join(root, "skills");
  const claudeSkillsDir = path.join(root, ".claude", "skills");
  const codexSkillsDir = path.join(root, ".codex", "skills");
  const cursorSkillsDir = path.join(root, ".cursor", "skills");
  const piSkillsDir = path.join(root, ".pi", "agent", "skills");
  const agentsSkillsDir = path.join(root, ".agents", "skills");
  const codexDir = path.join(root, "codex");
  const claudeDir = path.join(root, "claude");
  const claudeAppDir = path.join(root, "claude-app");
  const opencodeDir = path.join(root, "opencode");
  const cursorDir = path.join(root, "cursor");
  const piDir = path.join(root, "pi-agent");
  const evidenceDir = path.join(root, "evidence");
  const stateDir = path.join(root, "state");
  fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(piDir, "sessions"), { recursive: true });

  const skillPathIn = (skillsRoot, name) => path.join(skillsRoot, name, "SKILL.md");
  const skillPath = (name) => skillPathIn(skillsDir, name);
  const writeSkillAt = (skillsRoot, name) => {
    const file = skillPathIn(skillsRoot, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `---\nname: ${name}\ndescription: ${name} fixture skill for cleanup tests\n---\n# ${name}\n`,
    );
    return file;
  };
  const writeSkill = (name) => writeSkillAt(skillsDir, name);

  for (const name of [
    "stale-skill",
    "recent-skill",
    "mention-only",
    "never-used",
    ".system-skill",
  ]) {
    writeSkill(name);
  }

  fs.writeFileSync(
    path.join(codexDir, "sessions", "session.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-04-01T00:00:00Z",
        message: `<skill>\n<name>stale-skill</name>\n<path>${skillPath("stale-skill")}</path>\n</skill>`,
      }),
      JSON.stringify({
        timestamp: "2026-06-14T00:00:00Z",
        message: `Mention only: ${skillPath("mention-only")}`,
      }),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(claudeDir, "projects", "project.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-06-10T00:00:00Z",
      attributionSkill: "recent-skill",
    })}\n`,
  );

  return {
    root,
    skillsDir,
    claudeSkillsDir,
    codexSkillsDir,
    cursorSkillsDir,
    piSkillsDir,
    agentsSkillsDir,
    codexDir,
    claudeDir,
    claudeAppDir,
    opencodeDir,
    cursorDir,
    piDir,
    evidenceDir,
    stateDir,
    skillPath,
    skillPathIn,
    writeSkill,
    writeSkillAt,
  };
}

function makeVercelLockEntry(skillName) {
  return {
    source: "vercel-labs/agent-skills",
    sourceType: "github",
    sourceUrl: "https://github.com/vercel-labs/agent-skills",
    ref: "main",
    skillPath: `skills/${skillName}`,
    skillFolderHash: `hash-${skillName}`,
    installedAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-02T00:00:00.000Z",
  };
}

test("defaults to common installed skill roots and allows repeatable path overrides", () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.cache, true);
  assert.equal(parseArgs(["--no-cache"]).cache, false);
  assert.equal(defaults.skillsDirs.some((item) => item.endsWith("/.agents/skills")), true);
  assert.equal(defaults.skillsDirs.some((item) => item.endsWith("/.claude/skills")), true);
  assert.equal(defaults.skillsDirs.some((item) => item.endsWith("/.codex/skills")), true);
  assert.equal(defaults.skillsDirs.some((item) => item.endsWith("/.cursor/skills")), true);

  const custom = parseArgs(["--path", "/tmp/one", "--path", "/tmp/two"]);
  assert.deepEqual(custom.skillsDirs, ["/tmp/one", "/tmp/two"]);
  assert.equal(custom.skillsDir, "/tmp/one");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-context-doctor-plugin-root-"));
  const pluginSkills = path.join(
    root,
    "codex",
    "plugins",
    "cache",
    "market",
    "plugin",
    "version",
    "skills",
  );
  fs.mkdirSync(path.join(pluginSkills, "plugin-skill"), { recursive: true });
  fs.writeFileSync(path.join(pluginSkills, "plugin-skill", "SKILL.md"), "# plugin");
  const pluginDefaults = parseArgs(["--codex-dir", path.join(root, "codex")]);
  assert.equal(pluginDefaults.skillsDirs.includes(pluginSkills), true);
  const customOnly = parseArgs([
    "--codex-dir",
    path.join(root, "codex"),
    "--path",
    "/tmp/one",
  ]);
  assert.equal(customOnly.skillsDirs.includes(pluginSkills), false);
});

test("supports --version and -v options", async () => {
  assert.equal(parseArgs(["--version"]).version, true);
  assert.equal(parseArgs(["-v"]).version, true);

  let output = "";
  const io = {
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  };
  await main(["--version"], io);
  assert.match(output.trim(), /^\d+\.\d+\.\d+$/);
});

test("formats human numbers with separators", () => {
  assert.equal(formatNumber(11198), "11,198");
  assert.equal(formatNumber(33594.5), "33,594.5");
});

test("builds rows from verified Codex and Claude evidence", async () => {
  const fixture = makeFixture();
  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    source: "all",
    fullScan: true,
  });

  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });

  const byName = new Map(rows.map((row) => [row.skill, row]));
  assert.equal(byName.get("stale-skill").cleanup_candidate, true);
  assert.equal(byName.get("stale-skill").risk, "low");
  assert.equal(byName.get("stale-skill").description_token_cost > 0, true);
  assert.equal(byName.get("stale-skill").recent_signal_count, 0);
  assert.equal(byName.get("stale-skill").verified_uses_14d, 0);
  assert.equal(byName.get("stale-skill").used_14d_tokens, 0);
  assert.equal(byName.get("stale-skill").verified_uses_window, 0);
  assert.equal(byName.get("stale-skill").used_window_tokens, 0);
  assert.match(byName.get("stale-skill").cleanup_reason, /used/);
  assert.equal(byName.get("stale-skill").codex_usage_count, 1);
  assert.equal(byName.get("stale-skill").verified_use_count, 1);
  assert.equal(byName.get("stale-skill").last_verified_chat_title, "session");
  assert.match(byName.get("stale-skill").last_verified_href, /^file:\/\//);

  assert.equal(byName.get("recent-skill").cleanup_candidate, false);
  assert.equal(byName.get("recent-skill").recent_signal_count, 1);
  assert.equal(byName.get("recent-skill").verified_uses_14d, 1);
  assert.equal(
    byName.get("recent-skill").used_14d_tokens,
    byName.get("recent-skill").description_token_cost,
  );
  assert.equal(
    byName.get("recent-skill").used_window_tokens,
    byName.get("recent-skill").description_token_cost,
  );
  assert.equal(byName.get("recent-skill").claude_usage_count, 1);

  assert.equal(byName.get("mention-only").usage_count, 0);
  assert.equal(byName.get("mention-only").mention_count, 1);
  assert.equal(byName.get("mention-only").cleanup_candidate, false);
  assert.equal(byName.get("mention-only").risk, "protected");
  assert.match(byName.get("mention-only").cleanup_reason, /recent mention/);

  assert.equal(byName.get(".system-skill").cleanup_candidate, false);
  assert.equal(rows[0].cleanup_candidate, true);
});

test("falls back to a full JSONL scan when ripgrep is unavailable", () => {
  const fixture = makeFixture();
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("bin/skill-context-doctor.js"),
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--source",
      "codex",
      "--json",
      "--no-omit-file",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, HOME: fixture.root, PATH: fixture.root },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const byName = new Map(payload.rows.map((row) => [row.skill, row]));
  assert.equal(payload.scan.codex.strategy, "full-jsonl-fallback");
  assert.equal(byName.get("stale-skill").codex_usage_count, 1);
  assert.equal(byName.get("mention-only").mention_count, 1);
});

test("does not count model-disabled skill descriptions as catalog token cost", () => {
  const fixture = makeFixture();
  const disabledPath = fixture.writeSkill("manual-only");
  fs.writeFileSync(
    disabledPath,
    "---\nname: manual-only\ndescription: A detailed skill description that is only loaded when explicitly requested.\ndisable-model-invocation: true\n---\n# Manual only\n",
  );

  const rows = buildRows(collectSkills(fixture.skillsDir), {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });
  const byName = new Map(rows.map((row) => [row.skill, row]));

  assert.equal(byName.get("manual-only").disable_model_invocation, true);
  assert.equal(byName.get("manual-only").description_token_cost, 0);
  assert.equal(byName.get("stale-skill").description_token_cost > 0, true);
});

test("replays unchanged history and rescans only changed files", async () => {
  const fixture = makeFixture();
  fs.writeFileSync(path.join(fixture.codexDir, "sessions", "unchanged.jsonl"), "{}\n");
  const options = {
    skillsDir: fixture.skillsDir,
    skillsDirs: [fixture.skillsDir],
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    evidenceDirs: [],
    stateDir: fixture.stateDir,
    source: "all",
    fullScan: true,
    cache: true,
    now: NOW,
  };
  const coldSkills = collectSkills(fixture.skillsDir);
  const coldStats = await scanEvidence(coldSkills, options);
  assert.equal(coldStats.codex.scannedFiles > 0, true);

  const warmSkills = collectSkills(fixture.skillsDir);
  const warmStats = await scanEvidence(warmSkills, options);
  assert.equal(warmStats.codex.scannedFiles, 0);
  assert.equal(warmStats.codex.cachedFiles > 0, true);
  for (const [id, cold] of coldSkills) {
    const warm = warmSkills.get(id);
    assert.deepEqual(warm.usageEvents, cold.usageEvents);
    assert.deepEqual(warm.mentions, cold.mentions);
  }

  const changedFile = path.join(fixture.codexDir, "sessions", "session.jsonl");
  fs.appendFileSync(changedFile, `\n${JSON.stringify({ timestamp: "2026-06-15T00:00:00Z", message: "no skill evidence" })}\n`);
  const changedSkills = collectSkills(fixture.skillsDir);
  const changedStats = await scanEvidence(changedSkills, options);
  assert.equal(changedStats.codex.scannedFiles, 1);
  assert.equal(changedStats.codex.cachedFiles > 0, true);
  for (const [id, cold] of coldSkills) {
    assert.deepEqual(changedSkills.get(id).usageEvents, cold.usageEvents);
    assert.deepEqual(changedSkills.get(id).mentions, cold.mentions);
  }
});

test("scans history when the changed file list exceeds the exec argument limit", async () => {
  const fixture = makeFixture();
  const deepDir = path.join(
    fixture.codexDir,
    "sessions",
    "n".repeat(120),
    "e".repeat(120),
    "s".repeat(120),
    "t".repeat(120),
  );
  fs.mkdirSync(deepDir, { recursive: true });
  // Each path is ~700 bytes, so 2000 of them overflow the ~1MB macOS ARG_MAX.
  for (let index = 0; index < 2000; index += 1) {
    fs.writeFileSync(
      path.join(deepDir, `${"d".repeat(180)}-${index}.jsonl`),
      `${JSON.stringify({ timestamp: "2026-06-01T00:00:00Z", message: "no skill evidence" })}\n`,
    );
  }

  const skills = collectSkills(fixture.skillsDir);
  const stats = await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    skillsDirs: [fixture.skillsDir],
    codexDir: fixture.codexDir,
    stateDir: fixture.stateDir,
    source: "codex",
    cache: true,
    now: NOW,
  });

  assert.equal(stats.codex.scannedFiles > 2000, true);
  const stale = [...skills.values()].find((skill) => skill.skill === "stale-skill");
  assert.equal(stale.usageEvents.length > 0, true);
});

test("rescans old history when a skill is newly installed", async () => {
  const fixture = makeFixture();
  fs.appendFileSync(
    path.join(fixture.codexDir, "sessions", "session.jsonl"),
    `\n${JSON.stringify({ timestamp: "2026-06-14T12:00:00Z", message: "<command-name>future-skill</command-name>" })}\n`,
  );
  const options = {
    skillsDir: fixture.skillsDir,
    skillsDirs: [fixture.skillsDir],
    codexDir: fixture.codexDir,
    stateDir: fixture.stateDir,
    source: "codex",
    fullScan: true,
    cache: true,
    now: NOW,
  };
  await scanEvidence(collectSkills(fixture.skillsDir), options);

  fixture.writeSkill("future-skill");
  const expandedSkills = collectSkills(fixture.skillsDir);
  const stats = await scanEvidence(expandedSkills, options);
  const future = [...expandedSkills.values()].find((skill) => skill.skill === "future-skill");
  assert.equal(stats.codex.scannedFiles > 0, true);
  assert.equal(future.usageEvents.some((event) => event.kind === "codex_command_name_skill"), true);
});

test("keeps the loading event loop responsive while skills are scanned", async () => {
  const fixture = makeFixture();
  const largeFile = path.join(path.dirname(fixture.skillPath("never-used")), "large.bin");
  fs.writeFileSync(largeFile, "");
  fs.truncateSync(largeFile, 64 * 1024 * 1024);
  const phases = [];
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 10);

  const result = await scanSkillsInWorker({
    skillsDirs: [fixture.skillsDir],
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    source: "filesystem",
  }, (progress) => phases.push(progress.phase));
  clearInterval(timer);

  assert.equal(result.skills instanceof Map, true);
  assert.equal(result.skills.size, 5);
  assert.equal(ticks > 1, true);
  assert.deepEqual(phases, ["skills", "filesystem", "ranking"]);
});

test("preserves Codex tool-call context when scanning large histories", async () => {
  const fixture = makeFixture();
  fixture.writeSkill("large-history-read");
  const sessionsDir = path.join(fixture.codexDir, "sessions");
  const largeHistory = path.join(sessionsDir, "large-history.jsonl");
  fs.writeFileSync(largeHistory, "");
  fs.truncateSync(largeHistory, 51 * 1024 * 1024);
  fs.appendFileSync(
    path.join(sessionsDir, "session.jsonl"),
    `\n${JSON.stringify({
      timestamp: "2026-06-14T12:34:56Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec",
        input: `sed -n '1,240p' ${fixture.skillPath("large-history-read")}`,
      },
    })}\n`,
  );

  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    source: "codex",
  });
  const row = buildRows(skills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((item) => item.skill === "large-history-read");

  assert.equal(row.codex_usage_count, 1);
  assert.equal(row.last_used, "2026-06-14 12:34:56");
});

test("does not count Codex command names echoed by tool output", async () => {
  const fixture = makeFixture();
  fixture.writeSkill("echoed-command-name");
  fs.appendFileSync(
    path.join(fixture.codexDir, "sessions", "session.jsonl"),
    `\n${JSON.stringify({
      timestamp: "2026-06-14T12:34:56Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: "search result: <command-name>echoed-command-name</command-name>",
      },
    })}`,
  );

  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    source: "codex",
  });
  const row = buildRows(skills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((item) => item.skill === "echoed-command-name");

  assert.equal(row.codex_usage_count, 0);
  assert.equal(row.last_used, "");
});

test("preserves Claude tool-read context in large transcript records", async () => {
  const fixture = makeFixture();
  fixture.writeSkill("large-claude-read");
  fs.appendFileSync(
    path.join(fixture.claudeDir, "projects", "project.jsonl"),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-14T11:22:33Z",
      padding: "x".repeat(12_000),
      message: {
        content: [{
          type: "tool_use",
          name: "Read",
          input: { file_path: fixture.skillPath("large-claude-read") },
        }],
      },
    })}\n`,
  );

  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    source: "claude",
  });
  const row = buildRows(skills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((item) => item.skill === "large-claude-read");

  assert.equal(row.claude_usage_count, 1);
  assert.equal(row.last_used, "2026-06-14 11:22:33");
});

test("does not count Claude command names echoed by tool results", async () => {
  const fixture = makeFixture();
  fixture.writeSkill("echoed-claude-command");
  fs.appendFileSync(
    path.join(fixture.claudeDir, "projects", "project.jsonl"),
    `${JSON.stringify({
      type: "user",
      timestamp: "2026-06-14T11:22:33Z",
      message: {
        content: [{
          type: "tool_result",
          content: "search result: <command-name>echoed-claude-command</command-name>",
        }],
      },
    })}\n`,
  );

  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    source: "claude",
  });
  const row = buildRows(skills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((item) => item.skill === "echoed-claude-command");

  assert.equal(row.claude_usage_count, 0);
  assert.equal(row.last_used, "");
});

test("detects Claude Pathgrade tool events from live CLI snapshots", async () => {
  const fixture = makeFixture();
  fixture.writeSkill("pathgrade-live-skill");
  fs.appendFileSync(
    path.join(fixture.claudeDir, "projects", "project.jsonl"),
    `${JSON.stringify({
      type: "tool_event",
      timestamp: "2026-06-14T10:11:12Z",
      tool_event: {
        action: "use_skill",
        provider: "claude",
        providerToolName: "Read",
        arguments: { file_path: fixture.skillPath("pathgrade-live-skill") },
        skillName: "pathgrade-live-skill",
      },
    })}\n`,
  );

  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    source: "claude",
  });
  const row = buildRows(skills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((item) => item.skill === "pathgrade-live-skill");

  assert.equal(row.claude_usage_count, 1);
  assert.equal(row.last_used, "2026-06-14 10:11:12");
});

test("tracks Claude app, OpenCode, Cursor, and custom evidence signals", async () => {
  const fixture = makeFixture();
  for (const name of [
    "claude-app-skill",
    "claude-tool-read",
    "claude-nested-read",
    "claude-command-read",
    "claude-skill-tool",
    "claude-command-name",
    "claude-invoked-skill",
    "claude-config-skill",
    "claude-script",
    "codex-command-read",
    "codex-rg-read",
    "codex-script",
    "codex-command-name",
    "opencode-only",
    "opencode-read",
    "cursor-only",
    "cursor-sqlite",
    "cursor-transcript-read",
    "cursor-transcript-rg",
    "extra-evidence",
    "relative-command-read",
    "home-command-read",
    "braced-home-command-read",
  ]) {
    fixture.writeSkill(name);
  }

  const claudeSessionDir = path.join(fixture.claudeAppDir, "claude-code-sessions", "session");
  fs.mkdirSync(claudeSessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(claudeSessionDir, "conversation.json"),
    JSON.stringify({
      lastActivityAt: "2026-06-13T00:00:00Z",
      events: [{ attributionSkill: "claude-app-skill" }],
    }),
  );
  fs.appendFileSync(
    path.join(fixture.claudeDir, "projects", "project.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-07T00:00:00Z",
        tool: "Read",
        input: { file_path: fixture.skillPath("claude-tool-read") },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-06T12:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: fixture.skillPath("claude-nested-read") },
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-06T00:00:00Z",
        command: `cat ${fixture.skillPath("claude-command-read")}`,
      }),
      JSON.stringify({
        timestamp: "2026-06-06T13:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Skill",
              input: { skill: "claude-skill-tool", args: "" },
            },
          ],
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-06T14:00:00Z",
        message:
          "<command-name>claude-command-name</command-name><skill-format>true</skill-format>",
      }),
      JSON.stringify({
        timestamp: "2026-06-06T15:00:00Z",
        attachments: [
          {
            type: "invoked_skills",
            skills: [
              {
                name: "claude-invoked-skill",
                path: fixture.skillPath("claude-invoked-skill"),
                content: "# fixture",
              },
            ],
          },
        ],
      }),
      JSON.stringify({
        timestamp: "2026-06-06T16:00:00Z",
        command: `node ${path.dirname(fixture.skillPath("claude-script"))}/scripts/run.js`,
      }),
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(fixture.root, ".claude.json"),
    JSON.stringify({
      skillUsage: {
        "claude-config-skill": {
          usageCount: 2,
          lastUsedAt: "2026-06-06T17:00:00Z",
        },
      },
    }),
  );
  fs.appendFileSync(
    path.join(fixture.codexDir, "sessions", "session.jsonl"),
    [
      "",
      JSON.stringify({
        timestamp: "2026-06-05T00:00:00Z",
        message: `exec\nsed -n '1,120p' ${fixture.skillPath("codex-command-read")}\nsucceeded`,
      }),
      JSON.stringify({
        timestamp: "2026-06-04T00:00:00Z",
        message: `exec\nrg "description" ${fixture.skillPath("codex-rg-read")}\nsucceeded`,
      }),
      JSON.stringify({
        timestamp: "2026-06-04T01:00:00Z",
        message: `exec\nnode ${path.dirname(fixture.skillPath("codex-script"))}/scripts/run.js\nsucceeded`,
      }),
      JSON.stringify({
        timestamp: "2026-06-04T02:00:00Z",
        message:
          "<command-name>codex-command-name</command-name><skill-format>true</skill-format>",
      }),
      "",
    ].join("\n"),
  );

  const opencodeMessageDir = path.join(fixture.opencodeDir, "storage", "message", "session");
  fs.mkdirSync(opencodeMessageDir, { recursive: true });
  fs.writeFileSync(
    path.join(opencodeMessageDir, "message.json"),
    JSON.stringify({
      time: { created: "2026-06-12T00:00:00Z" },
      body: `Loaded ${fixture.skillPath("opencode-only")}`,
    }),
  );

  const opencodePartDir = path.join(fixture.opencodeDir, "storage", "part", "message");
  fs.mkdirSync(opencodePartDir, { recursive: true });
  fs.writeFileSync(
    path.join(opencodePartDir, "part.json"),
    JSON.stringify({
      type: "tool",
      tool: "read",
      state: {
        status: "completed",
        input: { filePath: fixture.skillPath("opencode-read") },
        time: { end: "2026-06-11T00:00:00Z" },
      },
    }),
  );

  const cursorChatDir = path.join(fixture.cursorDir, "chat");
  fs.mkdirSync(cursorChatDir, { recursive: true });
  const cursorTextStore = path.join(cursorChatDir, "store.db");
  const cursorTextSqlite = spawnSync(
    "sqlite3",
    [
      cursorTextStore,
      [
        "create table blobs (id text primary key, data blob);",
        `insert into blobs values ('message-1', '{"content":"read ${fixture.skillPath("cursor-only")}"}');`,
      ].join(" "),
    ],
    { encoding: "utf8" },
  );
  assert.equal(cursorTextSqlite.status, 0, cursorTextSqlite.stderr);

  const cursorSqliteDir = path.join(fixture.cursorDir, "sqlite-chat");
  fs.mkdirSync(cursorSqliteDir, { recursive: true });
  const cursorStore = path.join(cursorSqliteDir, "store.db");
  const sqlite = spawnSync(
    "sqlite3",
    [
      cursorStore,
      [
        "create table blobs (id text primary key, data blob);",
        `insert into blobs values ('message-1', '{"content":"read ${fixture.skillPath("cursor-sqlite")}"}');`,
      ].join(" "),
    ],
    { encoding: "utf8" },
  );
  assert.equal(sqlite.status, 0, sqlite.stderr);

  const cursorTranscriptDir = path.join(
    fixture.cursorDir,
    "projects",
    "fixture-project",
    "agent-transcripts",
    "session",
  );
  fs.mkdirSync(cursorTranscriptDir, { recursive: true });
  fs.writeFileSync(
    path.join(cursorTranscriptDir, "session.jsonl"),
    `${JSON.stringify({
      role: "assistant",
      timestamp: "2026-06-10T00:00:00Z",
      message: {
        content: [
          {
            type: "tool_use",
            name: "ReadFile",
            input: { path: fixture.skillPath("cursor-transcript-read") },
          },
          {
            type: "tool_use",
            name: "rg",
            input: {
              pattern: "description",
              path: fixture.skillPath("cursor-transcript-rg"),
            },
          },
        ],
      },
    })}\n`,
  );

  fs.mkdirSync(fixture.evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(fixture.evidenceDir, "agent.log"),
    `referenced ${fixture.skillPath("extra-evidence")}`,
  );
  fs.writeFileSync(
    path.join(fixture.evidenceDir, "commands.jsonl"),
    [
      JSON.stringify({
        timestamp: "2026-06-09T00:00:00Z",
        command: "cat .agents/skills/relative-command-read/SKILL.md",
      }),
      JSON.stringify({
        timestamp: "2026-06-08T00:00:00Z",
        command: "sed -n '1,120p' $HOME/.codex/skills/home-command-read/SKILL.md",
      }),
      JSON.stringify({
        timestamp: "2026-06-07T00:00:00Z",
        command:
          "head -40 ${HOME}/.codex/skills/braced-home-command-read/SKILL.md",
      }),
    ].join("\n"),
  );

  const skills = collectSkills(fixture.skillsDir);
  const stats = await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    evidenceDirs: [fixture.evidenceDir],
    stateDir: fixture.stateDir,
    source: "all",
    fullScan: false,
    cache: true,
  });
  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });
  const byName = new Map(rows.map((row) => [row.skill, row]));

  assert.equal(byName.get("stale-skill").codex_usage_count, 1);
  assert.equal(byName.get("stale-skill").last_verified_use, "2026-04-01 00:00:00");
  assert.equal(byName.get("claude-app-skill").claude_usage_count, 1);
  assert.equal(byName.get("claude-app-skill").last_direct_use, "2026-06-13 00:00:00");
  assert.equal(byName.get("claude-app-skill").last_verified_use, "2026-06-13 00:00:00");
  assert.equal(byName.get("claude-tool-read").claude_usage_count, 1);
  assert.equal(byName.get("claude-tool-read").last_verified_use, "2026-06-07 00:00:00");
  assert.equal(byName.get("claude-nested-read").claude_usage_count, 1);
  assert.equal(byName.get("claude-nested-read").last_verified_use, "2026-06-06 12:00:00");
  assert.equal(byName.get("claude-command-read").claude_usage_count, 1);
  assert.equal(byName.get("claude-command-read").last_verified_use, "2026-06-06 00:00:00");
  assert.equal(byName.get("claude-skill-tool").claude_usage_count, 1);
  assert.equal(byName.get("claude-skill-tool").last_verified_use, "2026-06-06 13:00:00");
  assert.equal(byName.get("claude-command-name").claude_usage_count, 1);
  assert.equal(byName.get("claude-command-name").last_verified_use, "2026-06-06 14:00:00");
  assert.equal(byName.get("claude-invoked-skill").claude_usage_count, 1);
  assert.equal(byName.get("claude-invoked-skill").last_verified_use, "2026-06-06 15:00:00");
  assert.equal(byName.get("claude-script").claude_usage_count, 1);
  assert.equal(byName.get("claude-script").last_verified_use, "2026-06-06 16:00:00");
  assert.equal(byName.get("claude-config-skill").claude_usage_count, 1);
  assert.equal(byName.get("claude-config-skill").last_verified_use, "2026-06-06 17:00:00");
  assert.equal(byName.get("codex-command-read").codex_usage_count, 1);
  assert.equal(byName.get("codex-command-read").last_verified_use, "2026-06-05 00:00:00");
  assert.equal(byName.get("codex-rg-read").codex_usage_count, 1);
  assert.equal(byName.get("codex-rg-read").last_verified_use, "2026-06-04 00:00:00");
  assert.equal(byName.get("codex-script").codex_usage_count, 1);
  assert.equal(byName.get("codex-script").last_verified_use, "2026-06-04 01:00:00");
  assert.equal(byName.get("codex-command-name").codex_usage_count, 1);
  assert.equal(byName.get("codex-command-name").last_verified_use, "2026-06-04 02:00:00");
  assert.equal(byName.get("opencode-only").opencode_mention_count, 1);
  assert.equal(byName.get("opencode-only").cleanup_candidate, false);
  assert.match(byName.get("opencode-only").cleanup_reason, /recent mention/);
  assert.equal(byName.get("opencode-read").opencode_usage_count, 1);
  assert.equal(byName.get("opencode-read").last_direct_use, "2026-06-11 00:00:00");
  assert.equal(byName.get("opencode-read").last_verified_use, "2026-06-11 00:00:00");
  assert.equal(byName.get("cursor-only").cursor_mention_count, 1);
  assert.equal(byName.get("cursor-sqlite").cursor_mention_count, 1);
  assert.equal(byName.get("cursor-transcript-read").cursor_usage_count, 1);
  assert.equal(
    byName.get("cursor-transcript-read").last_verified_use,
    "2026-06-10 00:00:00",
  );
  assert.equal(byName.get("cursor-transcript-rg").cursor_usage_count, 1);
  assert.equal(
    byName.get("cursor-transcript-rg").last_verified_use,
    "2026-06-10 00:00:00",
  );
  assert.equal(byName.get("extra-evidence").filesystem_mention_count, 1);
  assert.equal(byName.get("relative-command-read").filesystem_usage_count, 1);
  assert.equal(byName.get("relative-command-read").last_verified_use, "2026-06-09 00:00:00");
  assert.equal(byName.get("home-command-read").filesystem_usage_count, 1);
  assert.equal(byName.get("home-command-read").last_verified_use, "2026-06-08 00:00:00");
  assert.equal(byName.get("braced-home-command-read").filesystem_usage_count, 1);
  assert.equal(
    byName.get("braced-home-command-read").last_verified_use,
    "2026-06-07 00:00:00",
  );
  assert.equal(stats.codex.evidence, 6);
  assert.equal(stats.claude.evidence, 10);
  assert.equal(stats.opencode.evidence, 3);
  assert.equal(stats.cursor.evidence >= 4, true);
  assert.equal(stats.filesystem.evidence >= 4, true);

  const warmSkills = collectSkills(fixture.skillsDir);
  const warmStats = await scanEvidence(warmSkills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    evidenceDirs: [fixture.evidenceDir],
    stateDir: fixture.stateDir,
    source: "all",
    fullScan: false,
    cache: true,
  });
  for (const [id, cold] of skills) {
    assert.deepEqual(warmSkills.get(id).usageEvents, cold.usageEvents);
    assert.deepEqual(warmSkills.get(id).mentions, cold.mentions);
  }
  for (const source of ["codex", "claude", "opencode", "cursor", "filesystem"]) {
    assert.equal(warmStats[source].evidence, stats[source].evidence);
  }
});

test("collects skills from multiple install roots and matches their path evidence", async () => {
  const fixture = makeFixture();
  const roots = [
    fixture.skillsDir,
    fixture.claudeSkillsDir,
    fixture.codexSkillsDir,
    fixture.cursorSkillsDir,
  ];
  const claudeSkill = fixture.writeSkillAt(fixture.claudeSkillsDir, "claude-installed");
  const codexSkill = fixture.writeSkillAt(fixture.codexSkillsDir, "codex-installed");
  const cursorSkill = fixture.writeSkillAt(fixture.cursorSkillsDir, "cursor-installed");
  const duplicateDefaultSkill = fixture.writeSkillAt(fixture.skillsDir, "duplicate-installed");
  const duplicateCodexSkill = fixture.writeSkillAt(fixture.codexSkillsDir, "duplicate-installed");
  const pathReadDefaultSkill = fixture.writeSkillAt(fixture.skillsDir, "path-read-duplicate");
  fixture.writeSkillAt(fixture.codexSkillsDir, "path-read-duplicate");

  fs.appendFileSync(
    path.join(fixture.codexDir, "sessions", "session.jsonl"),
    `\n${JSON.stringify({
      timestamp: "2026-06-13T00:00:00Z",
      message: `<skill>\n<name>codex-installed</name>\n<path>${codexSkill}</path>\n</skill>`,
    })}\n${JSON.stringify({
      timestamp: "2026-06-13T12:00:00Z",
      message: `<skill>\n<name>duplicate-installed</name>\n<path>${duplicateCodexSkill}</path>\n</skill>`,
    })}\n${JSON.stringify({
      timestamp: "2026-06-13T13:00:00Z",
      command: `cat ${pathReadDefaultSkill}`,
    })}\n`,
  );
  fs.appendFileSync(
    path.join(fixture.claudeDir, "projects", "project.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-06-12T00:00:00Z",
      attributionSkill: "claude-installed",
    })}\n`,
  );
  const cursorChatDir = path.join(fixture.cursorDir, "chat");
  fs.mkdirSync(cursorChatDir, { recursive: true });
  const cursorStore = path.join(cursorChatDir, "store.db");
  const cursorSqlite = spawnSync(
    "sqlite3",
    [
      cursorStore,
      [
        "create table blobs (id text primary key, data blob);",
        `insert into blobs values ('message-1', '{"content":"mentioned ${cursorSkill}"}');`,
      ].join(" "),
    ],
    { encoding: "utf8" },
  );
  assert.equal(cursorSqlite.status, 0, cursorSqlite.stderr);

  const skills = collectSkills(roots);
  const stats = await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    skillsDirs: roots,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    source: "all",
    fullScan: true,
  });
  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });
  const byName = new Map(rows.map((row) => [row.skill, row]));

  assert.equal(byName.get("claude-installed").install_root, fixture.claudeSkillsDir);
  assert.equal(byName.get("claude-installed").claude_usage_count, 1);
  assert.equal(byName.get("codex-installed").install_root, fixture.codexSkillsDir);
  assert.equal(byName.get("codex-installed").codex_usage_count, 1);
  const duplicateRows = rows.filter((row) => row.skill === "duplicate-installed");
  assert.equal(duplicateRows.length, 1);
  assert.equal(duplicateRows[0].install_count, 2);
  assert.equal(duplicateRows[0].last_verified_use, "2026-06-13 12:00:00");
  const pathReadRows = rows.filter((row) => row.skill === "path-read-duplicate");
  assert.equal(pathReadRows.length, 1);
  assert.equal(pathReadRows[0].install_count, 2);
  assert.equal(pathReadRows[0].last_verified_scope, "direct");
  assert.equal(pathReadRows[0].last_verified_use, "2026-06-13 13:00:00");
  assert.equal(pathReadRows[0].usage_count, 1);
  assert.equal(pathReadRows[0].same_name_usage_count, 0);
  assert.equal(byName.get("cursor-installed").install_root, fixture.cursorSkillsDir);
  assert.equal(byName.get("cursor-installed").cursor_mention_count, 1);
  assert.equal(stats.cursor.evidence >= 1, true);
  assert.equal(fs.existsSync(claudeSkill), true);
  assert.equal(fs.existsSync(duplicateDefaultSkill), true);
});

test("groups identical duplicate skill installs", () => {
  const fixture = makeFixture();
  fixture.writeSkillAt(fixture.claudeSkillsDir, "duplicate-skill");
  fixture.writeSkillAt(fixture.codexSkillsDir, "duplicate-skill");

  const roots = [fixture.claudeSkillsDir, fixture.codexSkillsDir];
  const rows = buildRows(collectSkills(roots), {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].skill, "duplicate-skill");
  assert.equal(rows[0].install_count, 2);
  assert.match(formatTable(rows, 5, { recentNewChats: 2 }), /2 installs:/);
  assert.equal(formatCommands(rows).match(/rm -rf/g).length, 2);
});

test("keeps changed duplicate skill installs separate", () => {
  const fixture = makeFixture();
  fixture.writeSkillAt(fixture.claudeSkillsDir, "duplicate-skill");
  const changedSkill = fixture.writeSkillAt(fixture.codexSkillsDir, "duplicate-skill");
  fs.appendFileSync(changedSkill, "\nChanged local copy\n");

  const roots = [fixture.claudeSkillsDir, fixture.codexSkillsDir];
  const rows = buildRows(collectSkills(roots), {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });

  assert.equal(rows.length, 2);
  assert.equal(rows.every((row) => row.skill === "duplicate-skill"), true);
  assert.equal(rows.every((row) => row.install_count === 1), true);
  assert.doesNotMatch(formatTable(rows, 5, { recentNewChats: 2 }), /2 installs:/);
});

test("groups symlinked duplicate skill installs with the same target", () => {
  const fixture = makeFixture();
  const targetDir = path.join(fixture.root, "shared-targets", "duplicate-skill");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    path.join(targetDir, "SKILL.md"),
    "---\nname: duplicate-skill\ndescription: duplicate-skill fixture skill for cleanup tests\n---\n# duplicate-skill\n",
  );
  fs.mkdirSync(fixture.claudeSkillsDir, { recursive: true });
  fs.mkdirSync(fixture.codexSkillsDir, { recursive: true });
  fs.symlinkSync(targetDir, path.join(fixture.claudeSkillsDir, "duplicate-skill"));
  fs.symlinkSync(targetDir, path.join(fixture.codexSkillsDir, "duplicate-skill"));

  const roots = [fixture.claudeSkillsDir, fixture.codexSkillsDir];
  const rows = buildRows(collectSkills(roots), {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].skill, "duplicate-skill");
  assert.equal(rows[0].install_count, 2);
  assert.equal(rows[0].cleanup_candidate, true);
  assert.match(formatTable(rows, 5, { recentNewChats: 2 }), /2 installs:/);
  assert.equal(formatCommands(rows).match(/rm -rf/g).length, 2);

  const result = quarantineCandidates(rows, {
    stateDir: fixture.stateDir,
    now: NOW,
    recentNewChats: 2,
    savingsDays: 30,
    skillsDirs: roots,
  });
  assert.equal(result.count, 2);
  assert.equal(fs.existsSync(path.join(fixture.claudeSkillsDir, "duplicate-skill")), false);
  assert.equal(fs.existsSync(path.join(fixture.codexSkillsDir, "duplicate-skill")), false);
  assert.equal(fs.existsSync(path.join(targetDir, "SKILL.md")), true);
});

test("formats cleanup commands for candidates only", async () => {
  const fixture = makeFixture();
  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    source: "all",
    fullScan: true,
  });
  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });

  const commands = formatCommands(rows);
  assert.match(commands, /rm -rf '.*stale-skill'/);
  assert.match(commands, /rm -rf '.*never-used'/);
  assert.doesNotMatch(commands, /recent-skill/);
  assert.doesNotMatch(commands, /\.system-skill/);

  const table = formatTable(rows, 5, { recentNewChats: 2 });
  assert.match(table, /Skill Context Doctor/);
  assert.doesNotMatch(table, /stale skill cleanup, with receipts/);
  assert.match(table, /30d burn/);
  assert.match(table, /30d burn = description tokens multiplied by 2 new chats/);
  assert.match(table, /last_used/);
  assert.doesNotMatch(table, /last_verified_use/);
  assert.match(table, /installed date/);
  assert.doesNotMatch(table, /2026-04-01 00:00:00/);
  assert.match(table, /2026-04-01 00:00/);

  const linkedTable = formatTable(rows, 5, { links: true, recentNewChats: 2, savingsDays: 30 });
  assert.match(linkedTable, /\x1b]8;;file:\/\//);
});

test("renders the logo", () => {
  assert.equal(renderLogo(), "Skill Context Doctor");
});

test("omits cleanup candidates from cli patterns and omit files", async () => {
  const fixture = makeFixture();
  const omitFile = path.join(fixture.root, "omit.txt");
  fs.writeFileSync(omitFile, ["# keep these", "stale-skill", "mention-*"].join("\n"));

  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    source: "all",
    fullScan: true,
  });
  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
    omitPatterns: loadOmitPatterns({
      omitFile,
      noOmitFile: false,
      omitPatterns: ["never-used"],
    }),
  });

  const byName = new Map(rows.map((row) => [row.skill, row]));
  assert.equal(byName.get("stale-skill").cleanup_candidate, false);
  assert.equal(byName.get("stale-skill").omitted, true);
  assert.equal(byName.get("stale-skill").omit_pattern, "stale-skill");
  assert.equal(byName.get("mention-only").cleanup_candidate, false);
  assert.equal(byName.get("mention-only").omit_pattern, "mention-*");
  assert.equal(byName.get("never-used").cleanup_candidate, false);
  assert.equal(byName.get("never-used").omit_pattern, "never-used");
});

test("whitelist alias removes skills from json and commands output", async () => {
  const fixture = makeFixture();
  let jsonStdout = "";
  await main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--whitelist",
      "stale-skill",
      "--json",
      "--full-scan",
      "--no-omit-file",
    ],
    {
      now: NOW,
      stdout: { write: (chunk) => (jsonStdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  const payload = JSON.parse(jsonStdout);
  const stale = payload.rows.find((row) => row.skill === "stale-skill");
  assert.equal(payload.summary.omitted, 1);
  assert.equal(stale.cleanup_candidate, false);
  assert.equal(stale.omitted, true);

  let commandsStdout = "";
  await main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--omit",
      "stale-skill",
      "--commands",
      "--full-scan",
      "--no-omit-file",
    ],
    {
      now: NOW,
      stdout: { write: (chunk) => (commandsStdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  assert.doesNotMatch(commandsStdout, /stale-skill/);
  assert.match(commandsStdout, /never-used/);
});

test("direct omit command persists omit patterns", async () => {
  const fixture = makeFixture();
  const omitFile = path.join(fixture.root, "omit.txt");
  let stdout = "";

  await main(["omit", "stale-skill", "ck-*", "--omit-file", omitFile], {
    now: NOW,
    stdout: { write: (chunk) => (stdout += chunk) },
    stderr: { write: () => {} },
  });

  assert.match(stdout, /Omitted stale-skill/);
  assert.match(stdout, /Omitted ck-\*/);
  assert.match(fs.readFileSync(omitFile, "utf8"), /^stale-skill$/m);
  assert.match(fs.readFileSync(omitFile, "utf8"), /^ck-\*$/m);
});

test("direct list json includes risk and token cost without status", async () => {
  const fixture = makeFixture();
  let stdout = "";

  await main(
    [
      "list",
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--json",
      "--full-scan",
      "--no-omit-file",
    ],
    {
      now: NOW,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  const payload = JSON.parse(stdout);
  const stale = payload.rows.find((row) => row.skill === "stale-skill");
  assert.equal("status" in stale, false);
  assert.equal(stale.risk, "low");
  assert.equal(stale.description.includes("fixture skill"), true);
  assert.equal(stale.description_token_cost > 0, true);
  assert.equal(stale.used_14d_tokens, 0);
  assert.equal(stale.usage_count, stale.verified_use_count);
  assert.equal(stale.mention_count, stale.path_mention_count);
  assert.equal(stale.last_used, stale.last_verified_use);
  assert.equal(stale.last_seen, stale.last_any_signal);
  assert.equal(stale.last_direct_use, stale.last_strong_read);
  assert.equal(stale.recent_usage_count, stale.recent_strong_count);
  assert.equal(stale.recent_mention_count, stale.recent_weak_count);
  assert.equal(stale.last_verified_use, stale.last_strong_read);
  assert.equal(stale.last_any_signal, stale.last_signal_at);
  assert.equal(payload.summary.descriptionTokenCost > 0, true);
  assert.equal(payload.summary.used14dTokens > 0, true);
  assert.equal(payload.summary.usedWindowTokens > 0, true);
  assert.equal(payload.savingsDays, 30);
  assert.equal(payload.summary.recentNewChats, 1);
  assert.equal(payload.summary.potentialCandidateNewChatTokens, 22);
  assert.equal(payload.summary.recentActivitySignals, 2);
});

test("direct cleanup apply and undo latest commands work", async () => {
  const fixture = makeFixture();
  let cleanupStdout = "";

  await main(
    [
      "cleanup",
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--apply",
      "--full-scan",
    ],
    {
      now: NOW,
      stdout: { write: (chunk) => (cleanupStdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  assert.match(cleanupStdout, /Done: Quarantined 2 skills/);
  assert.match(cleanupStdout, /Saved per skill-catalog load: 22 description tokens/);
  assert.match(cleanupStdout, /Potential new-chat savings: 22 x 1 new chat in last 30 days = 22 tokens/);
  assert.match(cleanupStdout, /Command: skill-context-doctor --undo /);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), false);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), false);

  let undoStdout = "";
  await main(["undo", "latest", "--state-dir", fixture.stateDir], {
    now: NOW,
    stdout: { write: (chunk) => (undoStdout += chunk) },
    stderr: { write: () => {} },
  });

  assert.match(undoStdout, /Restored 2 skills/);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), true);
});

test("formats cleanup result with colors and token savings", () => {
  const output = formatCleanupResult(
    {
      mode: "quarantine",
      count: 1,
      manifest: "/tmp/skill-context-doctor/run/manifest.json",
      recentNewChats: 3,
      entries: [
        {
          skill: "stale-skill",
          originalPath: "/tmp/skills/stale-skill",
          quarantinedPath: "/tmp/state/items/stale-skill",
          descriptionTokenCost: 11198,
          recentUsageCount: 2,
          recentMentionCount: 1000,
        },
      ],
    },
    { colors: true, savingsDays: 30 },
  );

  assert.match(output, /\x1b\[/);
  assert.match(output, /Done: Quarantined 1 skill/);
  assert.match(output, /Saved per skill-catalog load: \x1b\[33m11,198\x1b\[0m description tokens/);
  assert.match(output, /Potential new-chat savings: \x1b\[33m11,198\x1b\[0m x \x1b\[36m3\x1b\[0m new chats in last 30 days = \x1b\[1;32m33,594\x1b\[0m tokens/);
  assert.match(output, /Observed selected-use prompt cost removed: \x1b\[33m22,396\x1b\[0m tokens/);
  assert.match(output, /Mentions in window: \x1b\[2m1,000\x1b\[0m/);
  assert.match(output, /Command: \x1b\[36mskill-context-doctor --undo \/tmp\/skill-context-doctor\/run\/manifest\.json\x1b\[0m/);
});

test("renders interactive cleanup candidates", async () => {
  const fixture = makeFixture();
  const skills = collectSkills(fixture.skillsDir);
  await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    codexDir: fixture.codexDir,
    claudeDir: fixture.claudeDir,
    claudeAppDir: fixture.claudeAppDir,
    opencodeDir: fixture.opencodeDir,
    cursorDir: fixture.cursorDir,
    source: "all",
    fullScan: true,
  });
  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });
  const staleRow = rows.find((row) => row.skill === "stale-skill");

  const screen = renderInteractiveScreen(
    rows,
    { cursor: 0, selected: new Set([staleRow.id]), recentNewChats: 2 },
    { columns: 120, rows: 24 },
  );

  assert.match(screen, /Skill Context Doctor/);
  assert.doesNotMatch(screen, /stale skill cleanup, with receipts/);
  assert.match(screen, /interactive cleanup/);
  assert.match(screen, /2 cleanup candidates/);
  assert.match(screen, /skill\s+tokens\s+30d burn\s+last use\s+sources\s+risk\s+installed/);
  assert.doesNotMatch(screen, /\x1b\[/);
  assert.doesNotMatch(screen, /status/);
  assert.doesNotMatch(screen, /last strong use/);
  assert.doesNotMatch(screen, /cleanup reason/);
  assert.match(screen, /\[x\] stale-skill\s+\d+\s+22/);
  assert.doesNotMatch(screen, /2026-04-01 00:00:00/);
  assert.match(screen, /used \d+ days ago/);
  assert.match(screen, /skills\s+low\s+\d{4}-\d{2}-\d{2}\s*$/m);
  assert.match(screen, /o omit/);
  assert.doesNotMatch(screen, /recent-skill/);

  const colorScreen = renderInteractiveScreen(
    rows,
    { cursor: 0, selected: new Set([staleRow.id]) },
    { columns: 120, rows: 24, colors: true },
  );

  assert.match(colorScreen, /\x1b\[/);
  assert.match(colorScreen, /\x1b\[1;36mSkill Context Doctor/);

  const linkedScreen = renderInteractiveScreen(
    rows,
    { cursor: 0, selected: new Set([staleRow.id]), recentNewChats: 2, savingsDays: 30 },
    { columns: 140, rows: 24, links: true },
  );

  assert.match(linkedScreen, /\x1b]8;;file:\/\//);

  const omittedScreen = renderInteractiveScreen(
    rows,
    { cursor: 0, selected: new Set(), omitted: new Set(["stale-skill"]) },
    { columns: 120, rows: 24 },
  );

  assert.match(omittedScreen, /1 cleanup candidates/);
  assert.match(omittedScreen, /1 omitted this run/);
  assert.doesNotMatch(omittedScreen, /\[.\] stale-skill/);

  const searchScreen = renderInteractiveScreen(
    rows,
    { cursor: 0, selected: new Set(), omitted: new Set(), search: "never" },
    { columns: 120, rows: 24 },
  );

  assert.match(searchScreen, /1 visible for \/never/);
  assert.match(searchScreen, /Search: \/never/);
  assert.match(searchScreen, /never-used/);
  assert.doesNotMatch(searchScreen, /stale-skill/);

  const confirmScreen = renderInteractiveScreen(
    rows,
    {
      cursor: 0,
      selected: new Set([staleRow.id]),
      omitted: new Set(),
      confirming: true,
      recentNewChats: 2,
      savingsDays: 30,
    },
    { columns: 120, rows: 24 },
  );

  assert.match(confirmScreen, /skill-context-doctor confirm cleanup/);
  assert.match(confirmScreen, /You are going to remove 1 skill from active use/);
  assert.match(confirmScreen, /stale-skill/);
  assert.match(confirmScreen, /paths: .*stale-skill\/SKILL\.md/);
  assert.match(confirmScreen, /Estimated impact:/);
  assert.match(confirmScreen, /11 tokens saved per new conversation/);
  assert.match(confirmScreen, /2 conversations in the last 30 days/);
  assert.match(confirmScreen, /≈ 22 tokens saved per month/);
  assert.match(confirmScreen, /Recent activity:/);
  assert.match(confirmScreen, /Uses\s+None/);
  assert.match(confirmScreen, /Mentions\s+None/);
  assert.doesNotMatch(confirmScreen, /skill-catalog load|Observed selected-use prompt cost/);
  assert.match(confirmScreen, /Press Enter to quarantine/);
  assert.match(confirmScreen, /Press d for permanent delete/);

  const deleteScreen = renderInteractiveScreen(
    rows,
    {
      cursor: 0,
      selected: new Set([staleRow.id]),
      omitted: new Set(),
      confirming: true,
      deleteMode: true,
      deleteConfirm: "dele",
      recentNewChats: 2,
      savingsDays: 30,
    },
    { columns: 120, rows: 24 },
  );

  assert.match(deleteScreen, /skill-context-doctor confirm permanent delete/);
  assert.match(deleteScreen, /Type DELETE then press Enter to permanently delete/);
  assert.match(deleteScreen, /DELETE confirmation: dele/);
});

test("renders interactive candidates with selected sort order", () => {
  const rows = [
    {
      id: "alpha",
      skill: "alpha",
      path: "/tmp/alpha/SKILL.md",
      cleanup_candidate: true,
      cleanup_reason: "old",
      risk: "medium",
      description_token_cost: 10,
      last_verified_use: "2026-06-01T00:00:00.000Z",
      installed_at: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "bravo",
      skill: "bravo",
      path: "/tmp/bravo/SKILL.md",
      cleanup_candidate: true,
      cleanup_reason: "older",
      risk: "low",
      description_token_cost: 30,
      last_verified_use: "",
      installed_at: "2026-05-01T00:00:00.000Z",
    },
    {
      id: "charlie",
      skill: "charlie",
      path: "/tmp/charlie/SKILL.md",
      cleanup_candidate: true,
      cleanup_reason: "oldest",
      risk: "protected",
      description_token_cost: 20,
      last_verified_use: "2026-06-10T00:00:00.000Z",
      installed_at: "2026-03-01T00:00:00.000Z",
    },
  ];

  function renderSorted(key, direction = "desc") {
    return renderInteractiveScreen(
      rows,
      {
        cursor: 0,
        selected: new Set(),
        recentNewChats: 4,
        sort: { key, direction },
      },
      { columns: 120, rows: 24 },
    );
  }

  function assertSkillOrder(screen, skills) {
    for (let index = 1; index < skills.length; index += 1) {
      assert.equal(screen.indexOf(skills[index - 1]) < screen.indexOf(skills[index]), true);
    }
  }

  const defaultScreen = renderSorted("default");
  assert.match(
    defaultScreen,
    /sel\s+skill\s+tokens\s+30d burn\s+last use\s+sources\s+risk\s+installed/,
  );

  const burnScreen = renderSorted("burn");
  assert.match(burnScreen, /Sort: 30d burn desc/);
  assertSkillOrder(burnScreen, ["bravo", "charlie", "alpha"]);

  const tokenScreen = renderSorted("tokens");
  assert.match(tokenScreen, /Sort: tokens desc/);
  assertSkillOrder(tokenScreen, ["bravo", "charlie", "alpha"]);

  const riskScreen = renderSorted("risk", "asc");
  assert.match(riskScreen, /Sort: risk asc/);
  assertSkillOrder(riskScreen, ["bravo", "alpha", "charlie"]);

  const installedScreen = renderSorted("installed");
  assert.match(installedScreen, /Sort: installed desc/);
  assertSkillOrder(installedScreen, ["bravo", "charlie", "alpha"]);

  const lastUsedScreen = renderSorted("last-used");
  assert.match(lastUsedScreen, /Sort: last used desc/);
  assertSkillOrder(lastUsedScreen, ["charlie", "alpha", "bravo"]);
});

test("renders interactive loading screen before evidence is ready", () => {
  const screen = renderInteractiveLoadingScreen(
    { frame: 2, phase: "codex", skillCount: 416, elapsedMs: 12_000 },
    { colors: false },
  );

  assert.match(screen, /Scanning agent history/);
  assert.match(screen, /Codex · 416 skills found/);
  assert.match(screen, /12s elapsed/);
  assert.match(screen, /First scan may take 1–3 minutes/);
  assert.match(screen, /Later scans only process changed history/);
  assert.doesNotMatch(screen, /review table will appear/);
  assert.doesNotMatch(screen, /preview-only/);
});

test("interactive mode defaults only for real terminals", () => {
  const defaults = {
    noInteractive: false,
    apply: false,
    commands: false,
    json: false,
    undo: "",
    csv: "",
    snapshot: "",
  };

  assert.equal(
    shouldRunInteractive(defaults, { stdin: { isTTY: true }, stdout: { isTTY: true } }),
    true,
  );
  assert.equal(
    shouldRunInteractive(defaults, { stdin: { isTTY: false }, stdout: { isTTY: true } }),
    false,
  );
  assert.equal(
    shouldRunInteractive({ ...defaults, noInteractive: true }, {
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }),
    false,
  );
  assert.equal(
    shouldRunInteractive({ ...defaults, command: "list" }, {
      stdin: { isTTY: true },
      stdout: { isTTY: true },
    }),
    false,
  );
});

test("interactive e2e selects with enter and quarantines confirmed rows", async () => {
  const fixture = makeFixture();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const run = main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--full-scan",
      "--no-omit-file",
    ],
    { now: NOW, stdin, stdout, stderr: { write: () => {} } },
  );

  assert.match(stdout.output, /Finding installed skills/);
  await waitForOutput(stdout, /Keys: \/ search/);
  press(stdin, "space", " ");
  press(stdin, "enter", "\r");
  await waitForOutput(stdout, /skill-context-doctor confirm cleanup/);
  assert.match(stdout.output, /You are going to remove 1 skill from active use/);
  assert.match(stdout.output, /11 tokens saved per new conversation/);
  assert.match(stdout.output, /1 conversation in the last 30 days/);
  assert.match(stdout.output, /≈ 11 tokens saved per month/);
  press(stdin, "down");
  await waitForOutput(stdout, /Press Enter to quarantine, d to delete permanently, or Esc to review/);
  press(stdin, "enter", "\r");

  const result = await run;
  assert.equal(result.cleanup.count, 1);
  assert.equal(result.cleanup.entries[0].skill, "stale-skill");
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), false);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), true);
  assert.match(stdout.output, /Done: Quarantined 1 skill/);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.isRaw, false);
});

test("interactive e2e permanently deletes only after typed confirmation", async () => {
  const fixture = makeFixture();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const run = main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--full-scan",
      "--no-omit-file",
    ],
    { now: NOW, stdin, stdout, stderr: { write: () => {} } },
  );

  await waitForOutput(stdout, /Keys: \/ search/);
  press(stdin, "space", " ");
  press(stdin, "enter", "\r");
  await waitForOutput(stdout, /skill-context-doctor confirm cleanup/);
  press(stdin, "d", "d");
  await waitForOutput(stdout, /skill-context-doctor confirm permanent delete/);
  press(stdin, "enter", "\r");
  await waitForOutput(stdout, /Type DELETE to permanently delete or Esc to review/);
  for (const char of "delete") press(stdin, char, char);
  await waitForOutput(stdout, /DELETE confirmation: delete/);
  press(stdin, "enter", "\r");

  const result = await run;
  assert.equal(result.cleanup.mode, "delete");
  assert.equal(result.cleanup.count, 1);
  assert.equal(result.cleanup.manifest, "");
  assert.equal(result.cleanup.entries[0].skill, "stale-skill");
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), false);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), true);
  assert.equal(fs.existsSync(path.join(fixture.stateDir, "runs")), false);
  assert.match(stdout.output, /Done: Permanently deleted 1 skill/);
  assert.match(stdout.output, /Permanent delete does not write an undo manifest/);
});

test("interactive e2e filters with slash search before cleanup", async () => {
  const fixture = makeFixture();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const run = main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--full-scan",
      "--no-omit-file",
    ],
    { now: NOW, stdin, stdout, stderr: { write: () => {} } },
  );

  await waitForOutput(stdout, /Keys: \/ search/);
  press(stdin, "slash", "/");
  await waitForOutput(stdout, /Search: \/_/);
  press(stdin, "n", "n");
  press(stdin, "e", "e");
  press(stdin, "v", "v");
  press(stdin, "e", "e");
  press(stdin, "r", "r");
  await waitForOutput(stdout, /1 visible for \/never/);
  press(stdin, "enter", "\r");
  press(stdin, "space", " ");
  press(stdin, "enter", "\r");
  await waitForOutput(stdout, /skill-context-doctor confirm cleanup/);
  press(stdin, "enter", "\r");

  const result = await run;
  assert.equal(result.cleanup.count, 1);
  assert.equal(result.cleanup.entries[0].skill, "never-used");
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), false);
});

test("interactive e2e applies sort hotkeys", async () => {
  const fixture = makeFixture();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const run = main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--full-scan",
      "--no-omit-file",
    ],
    { now: NOW, stdin, stdout, stderr: { write: () => {} } },
  );

  await waitForOutput(stdout, /Keys: \/ search/);
  press(stdin, "b", "b");
  await waitForOutput(stdout, /Sort: 30d burn desc/);
  press(stdin, "b", "b");
  await waitForOutput(stdout, /Sort: 30d burn asc/);
  press(stdin, "q");

  const result = await run;
  assert.equal(result.cancelled, true);
});

test("interactive e2e omits current row and persists omit pattern", async () => {
  const fixture = makeFixture();
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const omitFile = path.join(fixture.root, "interactive-omit.txt");
  const run = main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--omit-file",
      omitFile,
      "--full-scan",
    ],
    { now: NOW, stdin, stdout, stderr: { write: () => {} } },
  );

  await waitForOutput(stdout, /Keys: \/ search/);
  press(stdin, "o");
  await waitForOutput(stdout, /Omitted stale-skill/);
  press(stdin, "q");

  const result = await run;
  assert.equal(result.cancelled, true);
  assert.match(fs.readFileSync(omitFile, "utf8"), /^stale-skill$/m);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), true);
});

test("apply quarantines candidates and undo restores them", async () => {
  const fixture = makeFixture();
  let stdout = "";
  await main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--apply",
      "--full-scan",
    ],
    {
      now: NOW,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  assert.match(stdout, /Done: Quarantined 2 skills/);
  assert.match(stdout, /Manifest:/);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), false);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), false);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("mention-only"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("recent-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath(".system-skill"))), true);

  const latestState = JSON.parse(
    fs.readFileSync(path.join(fixture.stateDir, "latest.json"), "utf8"),
  );
  assert.equal(fs.existsSync(latestState.manifest), true);

  let undoStdout = "";
  await main(
    ["--state-dir", fixture.stateDir, "--undo", "latest"],
    {
      now: NOW,
      stdout: { write: (chunk) => (undoStdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  assert.match(undoStdout, /Restored 2 skills/);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("mention-only"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("recent-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath(".system-skill"))), true);
});

test("apply quarantines symlinked skills without moving the symlink target", async () => {
  const fixture = makeFixture();
  const targetDir = path.join(fixture.root, "shared", "linked-skill");
  const targetSkill = path.join(targetDir, "SKILL.md");
  const linkDir = path.join(fixture.cursorSkillsDir, "linked-skill");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(
    targetSkill,
    "---\nname: linked-skill\ndescription: linked skill fixture\n---\n# linked-skill\n",
  );
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  fs.symlinkSync(targetDir, linkDir, "dir");

  let stdout = "";
  await main(
    [
      "--path",
      fixture.cursorSkillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--apply",
      "--full-scan",
      "--no-omit-file",
    ],
    {
      now: NOW,
      stdout: { write: (chunk) => (stdout += chunk) },
      stderr: { write: () => {} },
    },
  );

  assert.match(stdout, /Done: Quarantined 1 skill/);
  assert.equal(fs.existsSync(linkDir), false);
  assert.equal(fs.existsSync(targetSkill), true);

  let undoStdout = "";
  await main(["undo", "latest", "--state-dir", fixture.stateDir], {
    now: NOW,
    stdout: { write: (chunk) => (undoStdout += chunk) },
    stderr: { write: () => {} },
  });

  assert.match(undoStdout, /Restored 1 skills/);
  assert.equal(fs.lstatSync(linkDir).isSymbolicLink(), true);
  assert.equal(fs.existsSync(targetSkill), true);
});

test("apply removes Vercel skills lock entries and undo restores them", async () => {
  const fixture = makeFixture();
  const previousXdgStateHome = process.env.XDG_STATE_HOME;
  const xdgStateHome = path.join(fixture.root, "xdg-state");
  const lockPath = path.join(xdgStateHome, "skills", ".skill-lock.json");

  process.env.XDG_STATE_HOME = xdgStateHome;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(
    lockPath,
    `${JSON.stringify(
      {
        version: 3,
        dismissed: { findSkillsPrompt: true },
        skills: {
          "stale-skill": makeVercelLockEntry("stale-skill"),
          "never-used": makeVercelLockEntry("never-used"),
          "recent-skill": makeVercelLockEntry("recent-skill"),
        },
      },
      null,
      2,
    )}\n`,
  );

  try {
    let stdout = "";
    await main(
      [
        "--path",
        fixture.skillsDir,
        "--codex-dir",
        fixture.codexDir,
        "--claude-dir",
        fixture.claudeDir,
        "--claude-app-dir",
        fixture.claudeAppDir,
        "--opencode-dir",
        fixture.opencodeDir,
        "--cursor-dir",
        fixture.cursorDir,
        "--pi-dir",
        fixture.piDir,
        "--unused-installed-days",
        "0",
        "--state-dir",
        fixture.stateDir,
        "--apply",
        "--full-scan",
      ],
      {
        now: NOW,
        stdout: { write: (chunk) => (stdout += chunk) },
        stderr: { write: () => {} },
      },
    );

    assert.match(stdout, /Vercel skills lock/);
    assert.match(stdout, /Removed 2 entries/);
    const lockAfterApply = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lockAfterApply.skills["stale-skill"], undefined);
    assert.equal(lockAfterApply.skills["never-used"], undefined);
    assert.equal(lockAfterApply.skills["recent-skill"].source, "vercel-labs/agent-skills");
    assert.equal(lockAfterApply.dismissed.findSkillsPrompt, true);

    const latestState = JSON.parse(
      fs.readFileSync(path.join(fixture.stateDir, "latest.json"), "utf8"),
    );
    const manifest = JSON.parse(fs.readFileSync(latestState.manifest, "utf8"));
    const staleEntry = manifest.entries.find((entry) => entry.skill === "stale-skill");
    assert.equal(staleEntry.vercelLockEntries[0].lockPath, lockPath);
    assert.equal(staleEntry.vercelLockEntries[0].entry.skillFolderHash, "hash-stale-skill");

    let undoStdout = "";
    await main(
      ["--state-dir", fixture.stateDir, "--undo", "latest"],
      {
        now: NOW,
        stdout: { write: (chunk) => (undoStdout += chunk) },
        stderr: { write: () => {} },
      },
    );

    assert.match(undoStdout, /Vercel skills lock: restored 2 entries/);
    const lockAfterUndo = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    assert.equal(lockAfterUndo.skills["stale-skill"].skillFolderHash, "hash-stale-skill");
    assert.equal(lockAfterUndo.skills["never-used"].skillFolderHash, "hash-never-used");
    assert.equal(lockAfterUndo.skills["recent-skill"].skillFolderHash, "hash-recent-skill");
    assert.equal(lockAfterUndo.dismissed.findSkillsPrompt, true);
  } finally {
    if (previousXdgStateHome === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = previousXdgStateHome;
    }
  }
});

test("interactive undo restores a selected cleanup run", async () => {
  const fixture = makeFixture();
  await main(
    [
      "--path",
      fixture.skillsDir,
      "--codex-dir",
      fixture.codexDir,
      "--claude-dir",
      fixture.claudeDir,
      "--claude-app-dir",
      fixture.claudeAppDir,
      "--opencode-dir",
      fixture.opencodeDir,
      "--cursor-dir",
      fixture.cursorDir,
      "--pi-dir",
      fixture.piDir,
      "--unused-installed-days",
      "0",
      "--state-dir",
      fixture.stateDir,
      "--apply",
      "--full-scan",
    ],
    {
      now: NOW,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
    },
  );

  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), false);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), false);

  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  const run = main(
    ["--state-dir", fixture.stateDir, "--undo"],
    {
      now: NOW,
      stdin,
      stdout,
      stderr: { write: () => {} },
    },
  );

  await waitForOutput(stdout, /skill-context-doctor interactive undo/);
  assert.match(stdout.output, /2\s+available/);
  press(stdin, "enter", "\r");
  await waitForOutput(stdout, /! REVIEW RESTORE/);
  assert.match(stdout.output, /Press Enter to restore\. Press Esc to return to review/);
  press(stdin, "down");
  await waitForOutput(stdout, /Press Enter to restore or Esc to review/);
  press(stdin, "enter", "\r");

  const result = await run;
  assert.equal(result.undo.restored.length, 2);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("stale-skill"))), true);
  assert.equal(fs.existsSync(path.dirname(fixture.skillPath("never-used"))), true);
  assert.match(stdout.output, /Restored 2 skills/);
  assert.equal(stdin.paused, true);
  assert.equal(stdin.isRaw, false);
});

test("renders interactive undo colors only when enabled", () => {
  const runs = [
    {
      id: "2026-06-15T00-00-00Z",
      createdAt: "2026-06-15T00:00:00Z",
      entries: [{ originalPath: "/tmp/skill", quarantinedPath: "/tmp/run/skill" }],
      manifest: "/tmp/skill-context-doctor/manifest.json",
      restoredAt: "",
      skipped: [],
    },
  ];

  const screen = renderInteractiveUndoScreen(runs, {}, { columns: 120, rows: 24 });
  assert.match(screen, /skill-context-doctor interactive undo/);
  assert.match(screen, /available/);
  assert.doesNotMatch(screen, /\x1b\[/);

  const colorScreen = renderInteractiveUndoScreen(runs, {}, { columns: 120, rows: 24, colors: true });
  assert.match(colorScreen, /\x1b\[/);
  assert.match(colorScreen, /\x1b\[1;36mskill-context-doctor interactive undo\x1b\[0m/);
});

test("bare undo requires a tty", async () => {
  const fixture = makeFixture();

  await assert.rejects(
    () =>
      main(["--state-dir", fixture.stateDir, "--undo"], {
        stdin: { isTTY: false },
        stdout: { isTTY: false, write: () => {} },
        stderr: { write: () => {} },
      }),
    /Interactive undo requires a TTY/,
  );
});

test("tracks PI agent evidence signals from session transcripts", async () => {
  const fixture = makeFixture();
  const sessionDir = path.join(fixture.piDir, "sessions", "fixture-workspace");
  fs.mkdirSync(sessionDir, { recursive: true });

  fixture.writeSkill("pi-command-skill");
  fixture.writeSkill("pi-tool-read");
  fixture.writeSkill("pi-bash-read");
  fixture.writeSkill("pi-mention-only");
  fixture.writeSkill("pi-assistant-mention");
  fixture.writeSkillAt(fixture.piSkillsDir, "pi-dotskill");
  fixture.writeSkillAt(fixture.agentsSkillsDir, "pi-agents-skill");

  fs.writeFileSync(
    path.join(sessionDir, "session-1.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:00:00Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Please help me with /skill:pi-command-skill now" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:01:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "You can also run /skill:pi-assistant-mention to do that" },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:02:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_1",
              name: "read",
              arguments: { path: fixture.skillPath("pi-tool-read") },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:03:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_2",
              name: "bash",
              arguments: {
                command: `head -n 20 ${fixture.skillPath("pi-bash-read")}`,
              },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:04:00Z",
        message: {
          role: "user",
          content: `Path reference: ${fixture.skillPath("pi-mention-only")}`,
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:05:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_3",
              name: "read",
              arguments: { path: fixture.skillPathIn(fixture.piSkillsDir, "pi-dotskill") },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:06:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call_4",
              name: "read",
              arguments: { path: fixture.skillPathIn(fixture.agentsSkillsDir, "pi-agents-skill") },
            },
          ],
        },
      }),
    ].join("\n") + "\n",
  );

  const skills = collectSkills([fixture.skillsDir, fixture.piSkillsDir, fixture.agentsSkillsDir]);
  const stats = await scanEvidence(skills, {
    skillsDir: fixture.skillsDir,
    piDir: fixture.piDir,
    source: "pi",
    fullScan: false,
    now: NOW,
  });

  const rows = buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: NOW,
  });
  const byName = new Map(rows.map((r) => [r.skill, r]));

  // 1. /skill:pi-command-skill in user message -> usage count 1
  assert.equal(byName.get("pi-command-skill").pi_usage_count, 1);
  assert.equal(byName.get("pi-command-skill").last_verified_use, "2026-06-10 10:00:00");

  // 2. tool read -> usage count 1
  assert.equal(byName.get("pi-tool-read").pi_usage_count, 1);
  assert.equal(byName.get("pi-tool-read").last_verified_use, "2026-06-10 10:02:00");

  // 3. bash read -> usage count 1
  assert.equal(byName.get("pi-bash-read").pi_usage_count, 1);
  assert.equal(byName.get("pi-bash-read").last_verified_use, "2026-06-10 10:03:00");

  // 4. mention only -> usage count 0, mention count 1
  assert.equal(byName.get("pi-mention-only").pi_usage_count, 0);
  assert.equal(byName.get("pi-mention-only").mention_count, 1);

  // 5. assistant text /skill:pi-assistant-mention -> MUST NOT be usage
  assert.equal(byName.get("pi-assistant-mention").pi_usage_count, 0);

  // 6. .pi/agent/skills/pi-dotskill toolCall read recognized and counted
  assert.equal(byName.get("pi-dotskill").pi_usage_count, 1);
  assert.equal(byName.get("pi-dotskill").last_verified_use, "2026-06-10 10:05:00");

  // 7. .agents/skills/pi-agents-skill toolCall read recognized and counted
  assert.equal(byName.get("pi-agents-skill").pi_usage_count, 1);
  assert.equal(byName.get("pi-agents-skill").last_verified_use, "2026-06-10 10:06:00");

  // 8. recentNewChats counts 1 session JSONL file (within 30d of NOW)
  assert.equal(stats.pi.recentNewChats, 1);
});

test("fast scan and full-scan produce identical evidence for PI /skill: commands", async () => {
  const fixture = makeFixture();
  const sessionDir = path.join(fixture.piDir, "sessions", "fast-vs-full");
  fs.mkdirSync(sessionDir, { recursive: true });

  fixture.writeSkill("fast-full-skill");

  fs.writeFileSync(
    path.join(sessionDir, "session.jsonl"),
    JSON.stringify({
      type: "message",
      timestamp: "2026-06-10T12:00:00Z",
      message: {
        role: "user",
        content: "/skill:fast-full-skill",
      },
    }) + "\n",
  );

  const fastSkills = collectSkills(fixture.skillsDir);
  await scanEvidence(fastSkills, {
    skillsDir: fixture.skillsDir,
    piDir: fixture.piDir,
    source: "pi",
    fullScan: false,
  });
  const fastRow = buildRows(fastSkills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((r) => r.skill === "fast-full-skill");

  const fullSkills = collectSkills(fixture.skillsDir);
  await scanEvidence(fullSkills, {
    skillsDir: fixture.skillsDir,
    piDir: fixture.piDir,
    source: "pi",
    fullScan: true,
  });
  const fullRow = buildRows(fullSkills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW })
    .find((r) => r.skill === "fast-full-skill");

  assert.equal(fastRow.pi_usage_count, 1);
  assert.equal(fullRow.pi_usage_count, 1);
  assert.equal(fastRow.last_verified_use, fullRow.last_verified_use);
});

test("groups symlinked duplicate skill installs between .pi/agent and other roots without duplicate identity", () => {
  const fixture = makeFixture();
  const targetSkill = fixture.writeSkillAt(fixture.piSkillsDir, "shared-skill");
  const linkDir = path.join(fixture.agentsSkillsDir, "shared-skill");
  fs.mkdirSync(path.dirname(linkDir), { recursive: true });
  fs.symlinkSync(path.dirname(targetSkill), linkDir, "dir");

  const skills = collectSkills([fixture.piSkillsDir, fixture.agentsSkillsDir]);
  const rows = buildRows(skills, { unusedDays: 45, unusedInstalledDays: 0, now: NOW });
  const sharedRows = rows.filter((r) => r.skill === "shared-skill");
  assert.equal(sharedRows.length, 1);
});

test("fast scan skips lines without candidate strings while full scan parses all lines exhaustively", async () => {
  const fixture = makeFixture();
  const sessionDir = path.join(fixture.piDir, "sessions", "exhaustive-test");
  fs.mkdirSync(sessionDir, { recursive: true });

  fixture.writeSkill("candidate-skill");

  fs.writeFileSync(
    path.join(sessionDir, "session.jsonl"),
    [
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:00:00Z",
        message: { role: "user", content: "General chat line without skill" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:01:00Z",
        message: { role: "assistant", content: "Another general response line" },
      }),
      JSON.stringify({
        type: "message",
        timestamp: "2026-06-10T10:02:00Z",
        message: { role: "user", content: "/skill:candidate-skill" },
      }),
    ].join("\n") + "\n",
  );

  const fastSkills = collectSkills(fixture.skillsDir);
  const fastStats = await scanEvidence(fastSkills, {
    skillsDir: fixture.skillsDir,
    piDir: fixture.piDir,
    source: "pi",
    fullScan: false,
    now: NOW,
  });
  assert.equal(fastStats.pi.parsedRecords, 1);

  const fullSkills = collectSkills(fixture.skillsDir);
  const fullStats = await scanEvidence(fullSkills, {
    skillsDir: fixture.skillsDir,
    piDir: fixture.piDir,
    source: "pi",
    fullScan: true,
    now: NOW,
  });
  assert.equal(fullStats.pi.parsedRecords, 3);
});
