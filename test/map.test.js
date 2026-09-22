import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/app.js";
import { buildCrossAgentMap, classifyRoot, formatCrossAgentMatrix, formatSkillDetailMap } from "../src/map.js";

function makeMapFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scd-map-test-"));
  const sharedDir = path.join(root, ".agents", "skills");
  const claudeDir = path.join(root, ".claude", "skills");
  const codexDir = path.join(root, ".codex", "skills");
  const cursorDir = path.join(root, ".cursor", "skills");
  const piDir = path.join(root, ".pi", "agent", "skills");

  fs.mkdirSync(sharedDir, { recursive: true });
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  fs.mkdirSync(cursorDir, { recursive: true });
  fs.mkdirSync(piDir, { recursive: true });

  return {
    root,
    sharedDir,
    claudeDir,
    codexDir,
    cursorDir,
    piDir,
    allDirs: [sharedDir, claudeDir, codexDir, cursorDir, piDir],
  };
}

test("classifyRoot correctly identifies standard agent roots and shared store", () => {
  assert.equal(classifyRoot("~/.agents/skills"), "shared");
  assert.equal(classifyRoot("/Users/foo/.agents/skills"), "shared");
  assert.equal(classifyRoot("~/.claude/skills"), "claude");
  assert.equal(classifyRoot("~/.codex/skills"), "codex");
  assert.equal(classifyRoot("~/.cursor/skills"), "cursor");
  assert.equal(classifyRoot("~/.pi/agent/skills"), "pi");
  assert.equal(classifyRoot("/path/to/opencode/skills"), "opencode");
  assert.equal(classifyRoot("/custom/path"), "custom");
});

test("Scenario 1: Two symlinks pointing to same realpath -> physicalCopies=1, canonicalStatus=RESOLVED, SHARED_BY_SYMLINK", () => {
  const fixture = makeMapFixture();
  const targetDir = path.join(fixture.sharedDir, "web-search");
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, "SKILL.md");
  fs.writeFileSync(targetFile, "---\ndescription: Web search\n---\n# Web Search");

  // Symlinks in claude and pi pointing to shared
  const claudeLink = path.join(fixture.claudeDir, "web-search");
  const piLink = path.join(fixture.piDir, "web-search");
  fs.symlinkSync(targetDir, claudeLink, "dir");
  fs.symlinkSync(targetDir, piLink, "dir");

  const skills = new Map([
    [
      `shared:web-search`,
      {
        skill: "web-search",
        installRoot: fixture.sharedDir,
        path: targetFile,
        realPath: targetFile,
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
    [
      `claude:web-search`,
      {
        skill: "web-search",
        installRoot: fixture.claudeDir,
        path: path.join(claudeLink, "SKILL.md"),
        realPath: targetFile,
        isSymlink: true,
        linkTarget: targetDir,
        disableModelInvocation: false,
        usageEvents: [{ kind: "claude_skill", source: "claude" }],
      },
    ],
    [
      `pi:web-search`,
      {
        skill: "web-search",
        installRoot: fixture.piDir,
        path: path.join(piLink, "SKILL.md"),
        realPath: targetFile,
        isSymlink: true,
        linkTarget: targetDir,
        disableModelInvocation: false,
        usageEvents: [{ kind: "pi_command", source: "pi" }],
      },
    ],
  ]);

  const lockEntries = new Map([
    [
      "web-search",
      [
        {
          source: "brave/brave-search-skills",
          sourceUrl: "https://github.com/brave/brave-search-skills.git",
          lockFile: path.join(fixture.root, ".agents", ".skill-lock.json"),
        },
      ],
    ],
  ]);

  const report = buildCrossAgentMap(skills, lockEntries);
  assert.equal(report.skills.length, 1);
  const item = report.skills[0];

  assert.equal(item.skill, "web-search");
  assert.equal(item.installation.physicalCopies, 1);
  assert.equal(item.installation.symlinks, 2);
  assert.equal(item.installation.canonicalStatus, "RESOLVED");
  assert.equal(item.installation.canonicalPath, fs.realpathSync(targetDir));
  assert.equal(item.ownershipStatus, "SINGLE_SOURCE");
  assert.equal(item.statuses.includes("SHARED_BY_SYMLINK"), true);

  // Exposures
  assert.equal(item.sharedStore.type, "physical");
  assert.equal(item.agentExposures.claude.type, "symlink");
  assert.equal(item.agentExposures.pi.type, "symlink");
  assert.equal(item.agentExposures.codex.type, "none");

  // Usages
  assert.equal(item.usage.claude.events, 1);
  assert.equal(item.usage.pi.events, 1);
});

test("Scenario 2: Two physical directories with identical SKILL.md -> physicalCopies=2, canonicalStatus=AMBIGUOUS, PHYSICAL_DUPLICATE", () => {
  const fixture = makeMapFixture();
  const dir1 = path.join(fixture.claudeDir, "docker");
  const dir2 = path.join(fixture.codexDir, "docker");
  fs.mkdirSync(dir1, { recursive: true });
  fs.mkdirSync(dir2, { recursive: true });
  const content = "---\ndescription: Docker helpers\n---\n# Docker";
  fs.writeFileSync(path.join(dir1, "SKILL.md"), content);
  fs.writeFileSync(path.join(dir2, "SKILL.md"), content);

  const skills = new Map([
    [
      `claude:docker`,
      {
        skill: "docker",
        installRoot: fixture.claudeDir,
        path: path.join(dir1, "SKILL.md"),
        realPath: path.join(dir1, "SKILL.md"),
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
    [
      `codex:docker`,
      {
        skill: "docker",
        installRoot: fixture.codexDir,
        path: path.join(dir2, "SKILL.md"),
        realPath: path.join(dir2, "SKILL.md"),
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildCrossAgentMap(skills, new Map());
  const item = report.skills[0];

  assert.equal(item.installation.physicalCopies, 2);
  assert.equal(item.installation.canonicalStatus, "AMBIGUOUS");
  assert.equal(item.installation.canonicalPath, null);
  assert.equal(item.installation.definitionHashes.length, 1);
  assert.equal(item.statuses.includes("PHYSICAL_DUPLICATE"), true);
  assert.equal(item.statuses.includes("SKILL_DEFINITION_DRIFT"), false);
});

test("Scenario 3: Two physical directories with different SKILL.md -> physicalCopies=2, canonicalStatus=AMBIGUOUS, SKILL_DEFINITION_DRIFT", () => {
  const fixture = makeMapFixture();
  const dir1 = path.join(fixture.claudeDir, "k8s");
  const dir2 = path.join(fixture.codexDir, "k8s");
  fs.mkdirSync(dir1, { recursive: true });
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir1, "SKILL.md"), "# K8s V1");
  fs.writeFileSync(path.join(dir2, "SKILL.md"), "# K8s V2 - Modified");

  const skills = new Map([
    [
      `claude:k8s`,
      {
        skill: "k8s",
        installRoot: fixture.claudeDir,
        path: path.join(dir1, "SKILL.md"),
        realPath: path.join(dir1, "SKILL.md"),
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
    [
      `codex:k8s`,
      {
        skill: "k8s",
        installRoot: fixture.codexDir,
        path: path.join(dir2, "SKILL.md"),
        realPath: path.join(dir2, "SKILL.md"),
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildCrossAgentMap(skills, new Map());
  const item = report.skills[0];

  assert.equal(item.installation.physicalCopies, 2);
  assert.equal(item.installation.canonicalStatus, "AMBIGUOUS");
  assert.equal(item.installation.canonicalPath, null);
  assert.equal(item.installation.definitionHashes.length, 2);
  assert.equal(item.statuses.includes("SKILL_DEFINITION_DRIFT"), true);
  assert.equal(item.statuses.includes("PHYSICAL_DUPLICATE"), false);
});

test("Scenario 4: Registered in lockfile but missing on disk -> physicalCopies=0, REGISTERED_BUT_MISSING", () => {
  const skills = new Map();
  const lockEntries = new Map([
    [
      "ghost-skill",
      [
        {
          source: "ghost/skills",
          sourceUrl: "https://github.com/ghost/skills.git",
          lockFile: "/path/to/.skill-lock.json",
        },
      ],
    ],
  ]);

  const report = buildCrossAgentMap(skills, lockEntries);
  const item = report.skills[0];

  assert.equal(item.skill, "ghost-skill");
  assert.equal(item.installation.physicalCopies, 0);
  assert.equal(item.installation.canonicalStatus, "MISSING");
  assert.equal(item.statuses.includes("REGISTERED_BUT_MISSING"), true);
});

test("Scenario 5: Historical usage only, current no installation -> physicalCopies=0, HISTORICAL_ONLY with usage intact", () => {
  const skills = new Map();
  skills.uninstalledUsage = new Map([
    [
      "django-tdd",
      {
        usageEvents: [
          { kind: "pi_command", source: "pi", ts: "2026-05-01T10:00:00.000Z" },
          { kind: "pi_command", source: "pi", ts: "2026-05-02T12:00:00.000Z" },
        ],
      },
    ],
  ]);

  const report = buildCrossAgentMap(skills, new Map());
  const item = report.skills[0];

  assert.equal(item.skill, "django-tdd");
  assert.equal(item.installation.physicalCopies, 0);
  assert.equal(item.installation.canonicalStatus, "MISSING");
  assert.equal(item.usage.pi.events, 2);
  assert.equal(item.usage.pi.lastUsed, "2026-05-02T12:00:00.000Z");
  assert.equal(item.statuses.includes("HISTORICAL_ONLY"), true);
});

test("Scenario 6: Per-exposure visibility is computed independently per copy", () => {
  const fixture = makeMapFixture();
  const claudeSkill = path.join(fixture.claudeDir, "multi-vis");
  const piSkill = path.join(fixture.piDir, "multi-vis");
  fs.mkdirSync(claudeSkill, { recursive: true });
  fs.mkdirSync(piSkill, { recursive: true });

  // Claude copy has disable-model-invocation: true
  fs.writeFileSync(
    path.join(claudeSkill, "SKILL.md"),
    "---\ndescription: test\ndisable-model-invocation: true\n---\n# Test",
  );
  // Pi copy has disable-model-invocation: false
  fs.writeFileSync(
    path.join(piSkill, "SKILL.md"),
    "---\ndescription: test\ndisable-model-invocation: false\n---\n# Test",
  );

  const skills = new Map([
    [
      `claude:multi-vis`,
      {
        skill: "multi-vis",
        installRoot: fixture.claudeDir,
        path: path.join(claudeSkill, "SKILL.md"),
        realPath: path.join(claudeSkill, "SKILL.md"),
        isSymlink: false,
        disableModelInvocation: true,
        usageEvents: [],
      },
    ],
    [
      `pi:multi-vis`,
      {
        skill: "multi-vis",
        installRoot: fixture.piDir,
        path: path.join(piSkill, "SKILL.md"),
        realPath: path.join(piSkill, "SKILL.md"),
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildCrossAgentMap(skills, new Map());
  const item = report.skills[0];

  assert.equal(item.agentExposures.claude.visible, false);
  assert.equal(item.agentExposures.pi.visible, true);
});

test("formatCrossAgentMatrix and formatSkillDetailMap render cleanly", () => {
  const fixture = makeMapFixture();
  const targetDir = path.join(fixture.sharedDir, "demo");
  fs.mkdirSync(targetDir, { recursive: true });
  const targetFile = path.join(targetDir, "SKILL.md");
  fs.writeFileSync(targetFile, "# Demo");

  const skills = new Map([
    [
      `shared:demo`,
      {
        skill: "demo",
        installRoot: fixture.sharedDir,
        path: targetFile,
        realPath: targetFile,
        isSymlink: false,
        disableModelInvocation: false,
        usageEvents: [{ kind: "pi_command", source: "pi" }],
      },
    ],
  ]);

  const report = buildCrossAgentMap(skills, new Map());
  const matrixText = formatCrossAgentMatrix(report);
  assert.match(matrixText, /Cross-Agent Skill Map/);
  assert.match(matrixText, /demo/);
  assert.match(matrixText, /SINGLE_INSTALLATION/);

  const detailText = formatSkillDetailMap(report.skills[0]);
  assert.match(detailText, /Skill: demo/);
  assert.match(detailText, /Canonical Installation/);
  assert.match(detailText, /Shared Store/);
});

test("CLI integration: skill-context-doctor map outputs matrix, detail, and --json", async () => {
  let matrixOut = "";
  const ioMatrix = {
    stdout: {
      write(chunk) {
        matrixOut += chunk;
      },
    },
  };
  await main(["map", "--limit", "5"], ioMatrix);
  assert.match(matrixOut, /Cross-Agent Skill Map/);
  assert.match(matrixOut, /Skill/);
  assert.match(matrixOut, /Shared/);

  let jsonOut = "";
  const ioJson = {
    stdout: {
      write(chunk) {
        jsonOut += chunk;
      },
    },
  };
  await main(["map", "--json", "--limit", "2"], ioJson);
  const parsed = JSON.parse(jsonOut);
  assert.equal(typeof parsed.summary, "object");
  assert.equal(Array.isArray(parsed.skills), true);
});
