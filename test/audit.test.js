import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildAuditReport, detectBrokenSkills, detectEvidenceSources, formatAuditReport } from "../src/audit.js";
import { main } from "../src/app.js";

function makeAuditFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-context-doctor-audit-test-"));
  const skillsDirA = path.join(root, "rootA", "skills");
  const skillsDirB = path.join(root, "rootB", "skills");
  const piDir = path.join(root, ".pi", "agent");
  const stateDir = path.join(root, "state");

  fs.mkdirSync(skillsDirA, { recursive: true });
  fs.mkdirSync(skillsDirB, { recursive: true });
  fs.mkdirSync(path.join(piDir, "sessions"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  function addSkill(dir, name, { description = "default description", disableModel = false } = {}) {
    const skillPath = path.join(dir, name, "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    const content = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      disableModel ? "disable-model-invocation: true" : "",
      "---",
      `# ${name}`,
    ].filter(Boolean).join("\n");
    fs.writeFileSync(skillPath, `${content}\n`);
    return skillPath;
  }

  return {
    root,
    skillsDirA,
    skillsDirB,
    piDir,
    stateDir,
    addSkill,
  };
}

test("audit summary calculates uniqueSkills, installations, modelVisible, used, stale, neverUsed", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const skills = new Map([
    [
      "root:used-recent",
      {
        id: "root:used-recent",
        skill: "used-recent",
        description: "A skill used recently with thirty two characters here",
        disableModelInvocation: false,
        usageEvents: [{ kind: "pi_slash_command", ts: new Date("2026-09-20T10:00:00.000Z") }],
      },
    ],
    [
      "root:used-stale",
      {
        id: "root:used-stale",
        skill: "used-stale",
        description: "A skill used long ago",
        disableModelInvocation: false,
        usageEvents: [{ kind: "codex_tool_read", ts: new Date("2026-06-01T10:00:00.000Z") }],
      },
    ],
    [
      "root:never-used",
      {
        id: "root:never-used",
        skill: "never-used",
        description: "A skill never used",
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildAuditReport(skills, [], { unusedDays: 45, now });

  assert.equal(report.summary.uniqueSkills, 3);
  assert.equal(report.summary.installations, 3);
  assert.equal(report.summary.modelVisible, 3);
  assert.equal(report.summary.used, 2);
  assert.equal(report.summary.stale, 1);
  assert.equal(report.summary.neverUsed, 1);
  assert.equal(report.summary.used + report.summary.neverUsed, report.summary.uniqueSkills);
  assert.equal(report.summary.stale <= report.summary.used, true);
  assert.equal(report.summary.estimatedVisibleSkillTokens > 0, true);
});

test("audit handles duplicate installs across roots without inflating uniqueSkills", () => {
  const skills = new Map([
    [
      "rootA:common-tool",
      {
        id: "rootA:common-tool",
        skill: "common-tool",
        description: "Common tool description",
        disableModelInvocation: false,
        usageEvents: [{ kind: "pi_tool_call", ts: new Date("2026-09-20T00:00:00Z") }],
      },
    ],
    [
      "rootB:common-tool",
      {
        id: "rootB:common-tool",
        skill: "common-tool",
        description: "Common tool description",
        disableModelInvocation: false,
        usageEvents: [{ kind: "pi_tool_call", ts: new Date("2026-09-20T00:00:00Z") }],
      },
    ],
  ]);

  const report = buildAuditReport(skills, [], {});

  assert.equal(report.summary.uniqueSkills, 1);
  assert.equal(report.summary.installations, 2);
  assert.equal(report.summary.duplicateGroups, 1);
  assert.equal(report.summary.duplicateCopies, 1);
});

test("audit honors disable-model-invocation: true with 0 visible tokens and excludes from top consumers", () => {
  const skills = new Map([
    [
      "root:hidden-worker",
      {
        id: "root:hidden-worker",
        skill: "hidden-worker",
        description: "This is a very long hidden description that would have high token cost",
        disableModelInvocation: true,
        usageEvents: [{ kind: "pi_tool_call", ts: new Date("2026-09-20T00:00:00Z") }],
      },
    ],
    [
      "root:visible-worker",
      {
        id: "root:visible-worker",
        skill: "visible-worker",
        description: "Short visible description",
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildAuditReport(skills, [], {});

  assert.equal(report.summary.uniqueSkills, 2);
  assert.equal(report.summary.modelVisible, 1);
  assert.equal(report.topConsumers.length, 1);
  assert.equal(report.topConsumers[0].skill, "visible-worker");
  assert.equal(report.topConsumers.some((item) => item.skill === "hidden-worker"), false);
});

test("audit honors dot-prefixed internal skills as not model-visible", () => {
  const skills = new Map([
    [
      "root:.system-prompt",
      {
        id: "root:.system-prompt",
        skill: ".system-prompt",
        description: "Internal system instructions",
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildAuditReport(skills, [], {});

  assert.equal(report.summary.uniqueSkills, 1);
  assert.equal(report.summary.modelVisible, 0);
  assert.equal(report.summary.estimatedVisibleSkillTokens, 0);
  assert.equal(report.topConsumers.length, 0);
});

test("audit detects broken symlinks and missing SKILL.md", () => {
  const fixture = makeAuditFixture();

  // Valid skill
  fixture.addSkill(fixture.skillsDirA, "valid-skill");

  // Missing SKILL.md (empty directory)
  const emptyDir = path.join(fixture.skillsDirA, "empty-skill");
  fs.mkdirSync(emptyDir, { recursive: true });

  // Broken symlink pointing to nonexistent path
  const brokenLink = path.join(fixture.skillsDirA, "broken-symlink");
  fs.symlinkSync(path.join(fixture.root, "nonexistent-target"), brokenLink);

  const broken = detectBrokenSkills([fixture.skillsDirA]);

  assert.equal(broken.length, 2);
  const reasons = broken.map((b) => b.reason);
  assert.equal(reasons.includes("missing SKILL.md"), true);
  assert.equal(reasons.includes("broken symlink target"), true);
});

test("audit breaks down sources into usedSkills and usageEvents", () => {
  const skills = new Map([
    [
      "root:skill-one",
      {
        id: "root:skill-one",
        skill: "skill-one",
        description: "Skill one",
        disableModelInvocation: false,
        usageEvents: [
          { kind: "pi_slash_command", ts: new Date("2026-09-20T00:00:00Z") },
          { kind: "pi_tool_call", ts: new Date("2026-09-20T01:00:00Z") },
          { kind: "codex_tool_read", ts: new Date("2026-09-20T02:00:00Z") },
        ],
      },
    ],
    [
      "root:skill-two",
      {
        id: "root:skill-two",
        skill: "skill-two",
        description: "Skill two",
        disableModelInvocation: false,
        usageEvents: [{ kind: "pi_tool_call", ts: new Date("2026-09-20T03:00:00Z") }],
      },
    ],
  ]);

  const report = buildAuditReport(skills, [], {});

  assert.equal(report.sources.pi.usedSkills, 2);
  assert.equal(report.sources.pi.usageEvents, 3);
  assert.equal(report.sources.codex.usedSkills, 1);
  assert.equal(report.sources.codex.usageEvents, 1);
  assert.equal(report.sources.claude.usedSkills, 0);
  assert.equal(report.sources.claude.usageEvents, 0);
});

test("audit ranks topConsumers by visible tokens descending", () => {
  const skills = new Map([
    [
      "root:small-skill",
      {
        id: "root:small-skill",
        skill: "small-skill",
        description: "Short",
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
    [
      "root:large-skill",
      {
        id: "root:large-skill",
        skill: "large-skill",
        description: "This is a much longer description that takes considerably more tokens than the short one",
        disableModelInvocation: false,
        usageEvents: [],
      },
    ],
  ]);

  const report = buildAuditReport(skills, [], { limit: 5 });

  assert.equal(report.topConsumers.length, 2);
  assert.equal(report.topConsumers[0].skill, "large-skill");
  assert.equal(report.topConsumers[1].skill, "small-skill");
  assert.equal(report.topConsumers[0].visibleTokens > report.topConsumers[1].visibleTokens, true);
});

test("audit --json outputs valid structured JSON payload via main CLI", async () => {
  const fixture = makeAuditFixture();
  fixture.addSkill(fixture.skillsDirA, "demo-skill", { description: "Demo description" });

  let stdout = "";
  const result = await main(
    [
      "audit",
      "--path",
      fixture.skillsDirA,
      "--pi-dir",
      fixture.piDir,
      "--state-dir",
      fixture.stateDir,
      "--json",
      "--no-cache",
    ],
    { stdout: { write: (chunk) => (stdout += chunk) } },
  );

  assert.ok(result);
  assert.equal(result.summary.uniqueSkills, 1);
  assert.equal(result.summary.installations, 1);
  assert.equal(result.summary.modelVisible, 1);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.summary.uniqueSkills, 1);
  assert.equal(parsed.summary.installations, 1);
  assert.equal(parsed.summary.modelVisible, 1);
  assert.ok(parsed.sources);
  assert.ok(Array.isArray(parsed.topConsumers));
});

test("formatAuditReport renders human-readable text report with logo and sections", () => {
  const report = {
    summary: {
      uniqueSkills: 10,
      installations: 12,
      modelVisible: 8,
      used: 6,
      stale: 2,
      neverUsed: 4,
      duplicateGroups: 2,
      duplicateCopies: 2,
      broken: 1,
      estimatedVisibleSkillTokens: 1200,
    },
    sources: {
      pi: { usedSkills: 4, usageEvents: 10 },
      claude: { usedSkills: 2, usageEvents: 5 },
      codex: { usedSkills: 0, usageEvents: 0 },
      opencode: { usedSkills: 0, usageEvents: 0 },
      cursor: { usedSkills: 0, usageEvents: 0 },
      filesystem: { usedSkills: 0, usageEvents: 0 },
    },
    topConsumers: [
      {
        skill: "heavy-skill",
        visibleTokens: 450,
        usageCount: 8,
        lastUsed: "2026-09-20 12:00",
      },
    ],
    brokenDetails: [{ name: "broken-one", path: "/tmp/broken", reason: "missing SKILL.md" }],
    evidenceSources: ["Pi", "Claude Code"],
  };

  const text = formatAuditReport(report, { unusedDays: 45 });

  assert.match(text, /Skill Context Doctor/);
  assert.match(text, /Evidence sources detected: Pi, Claude Code/);
  assert.match(text, /Skills & Installation Health/);
  assert.match(text, /Skills discovered\s+10/);
  assert.match(text, /Installations\s+12/);
  assert.match(text, /Model-visible\s+8/);
  assert.match(text, /Actually used\s+6/);
  assert.match(text, /Stale \(idle >45d\)\s+2/);
  assert.match(text, /Never used\s+4/);
  assert.match(text, /Duplicate groups\s+2 \(2 extra copies\)/);
  assert.match(text, /Broken installations\s+1/);
  assert.match(text, /Estimated Context Overhead/);
  assert.match(text, /Visible skill metadata\s+~1\.2K tokens \(1,200 tokens\)/);
  assert.match(text, /Usage Sources Breakdown/);
  assert.match(text, /Pi\s+4 skills \(10 events\)/);
  assert.match(text, /Claude Code\s+2 skills \(5 events\)/);
  assert.match(text, /Top Context Consumers \(Model-Visible\)/);
  assert.match(text, /heavy-skill\s+450\s+8\s+2026-09-20 12:00/);
});
