import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyOptimization,
  formatOptimizeReport,
  patchFrontmatterDisableModel,
  planOptimization,
  restoreOptimizationRun,
} from "../src/optimize.js";
import { isKeepProtected, loadKeepNames } from "../src/keep.js";
import { main } from "../src/app.js";

function makeOptimizeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-context-doctor-optimize-test-"));
  const skillsDir = path.join(root, "skills");
  const stateDir = path.join(root, "state");
  const keepFile = path.join(stateDir, "keep");
  const codexDir = path.join(root, "codex");
  const claudeDir = path.join(root, "claude");
  const piDir = path.join(root, "pi");
  const opencodeDir = path.join(root, "opencode");
  const cursorDir = path.join(root, "cursor");

  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(path.join(codexDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
  fs.mkdirSync(path.join(piDir, "sessions"), { recursive: true });

  const cliArgs = (extra = []) => [
    "--skills-dir",
    skillsDir,
    "--state-dir",
    stateDir,
    "--codex-dir",
    codexDir,
    "--claude-dir",
    claudeDir,
    "--pi-dir",
    piDir,
    "--opencode-dir",
    opencodeDir,
    "--cursor-dir",
    cursorDir,
    ...extra,
  ];

  function addSkill(name, {
    content,
    frontmatter = {},
    rawFrontmatter = null,
  } = {}) {
    const skillDir = path.join(skillsDir, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    fs.mkdirSync(skillDir, { recursive: true });

    if (content !== undefined) {
      fs.writeFileSync(skillPath, content);
      return { skillDir, skillPath };
    }

    if (rawFrontmatter !== null) {
      fs.writeFileSync(skillPath, `${rawFrontmatter}\n# ${name}\n`);
      return { skillDir, skillPath };
    }

    const lines = ["---", `name: ${name}`];
    for (const [k, v] of Object.entries(frontmatter)) {
      lines.push(`${k}: ${v}`);
    }
    lines.push("---", "", `# ${name}`);
    fs.writeFileSync(skillPath, lines.join("\n"));
    return { skillDir, skillPath };
  }

  return {
    root,
    skillsDir,
    stateDir,
    keepFile,
    cliArgs,
    addSkill,
  };
}

// ---------------------------------------------------------
// 1. patchFrontmatterDisableModel tests
// ---------------------------------------------------------

test("patchFrontmatterDisableModel adds frontmatter when document has none", () => {
  const input = Buffer.from("# Heading\n\nSome body content here.\n");
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, true);
  const text = result.buffer.toString("utf8");
  assert.match(text, /^---\ndisable-model-invocation: true\n---\n\n# Heading/);
});

test("patchFrontmatterDisableModel inserts disable-model-invocation into existing frontmatter", () => {
  const input = Buffer.from("---\nname: my-skill\ndescription: test\n---\n\n# Heading\n");
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, true);
  const text = result.buffer.toString("utf8");
  assert.match(text, /disable-model-invocation: true/);
  assert.match(text, /name: my-skill/);
  assert.match(text, /description: test/);
});

test("patchFrontmatterDisableModel flips false to true", () => {
  const input = Buffer.from("---\nname: my-skill\ndisable-model-invocation: false\n---\n# Title\n");
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, true);
  assert.equal(result.beforeValue, false);
  assert.equal(result.afterValue, true);
  const text = result.buffer.toString("utf8");
  assert.match(text, /disable-model-invocation: true/);
  assert.doesNotMatch(text, /disable-model-invocation: false/);
});

test("patchFrontmatterDisableModel recognizes alreadyDisabled when true", () => {
  const input = Buffer.from("---\nname: my-skill\ndisable-model-invocation: true\n---\n# Title\n");
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, true);
  assert.equal(result.alreadyDisabled, true);
});

test("patchFrontmatterDisableModel preserves CRLF line endings", () => {
  const input = Buffer.from("---\r\nname: crlf-skill\r\ndescription: crlf\r\n---\r\n# Title\r\n");
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, true);
  const text = result.buffer.toString("utf8");
  assert.ok(text.includes("\r\n"));
  assert.ok(text.includes("disable-model-invocation: true\r\n"));
});

test("patchFrontmatterDisableModel preserves UTF-8 BOM", () => {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const doc = Buffer.from("---\nname: bom-skill\n---\n# Title\n");
  const input = Buffer.concat([bom, doc]);

  const result = patchFrontmatterDisableModel(input);
  assert.equal(result.success, true);
  assert.equal(result.buffer[0], 0xef);
  assert.equal(result.buffer[1], 0xbb);
  assert.equal(result.buffer[2], 0xbf);
});

test("patchFrontmatterDisableModel rejects unclosed frontmatter", () => {
  const input = Buffer.from("---\nname: unclosed-skill\nNo closing delimiter here\n");
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, false);
  assert.equal(result.reason, "UNCLOSED_FRONTMATTER");
});

test("patchFrontmatterDisableModel rejects duplicate disable-model-invocation keys", () => {
  const input = Buffer.from(
    "---\nname: dupe\ndisable-model-invocation: false\ndisable-model-invocation: true\n---\n",
  );
  const result = patchFrontmatterDisableModel(input);

  assert.equal(result.success, false);
  assert.equal(result.reason, "DUPLICATE_DISABLE_MODEL_INVOCATION");
});

// ---------------------------------------------------------
// 2. Keep whitelist tests
// ---------------------------------------------------------

test("loadKeepNames parses --keep and keep file with exact matching", () => {
  const fixture = makeOptimizeFixture();
  fs.writeFileSync(fixture.keepFile, "web-design\n# comment\nplaywright-core\n");

  const keepNames = loadKeepNames({
    keep: ["my-special-skill", "web-design"],
    keepFile: fixture.keepFile,
  });

  assert.ok(isKeepProtected("my-special-skill", keepNames));
  assert.ok(isKeepProtected("web-design", keepNames));
  assert.ok(isKeepProtected("playwright-core", keepNames));

  // Exact matching only: prefix/suffix should NOT match
  assert.equal(isKeepProtected("web-design-pro", keepNames), false);
  assert.equal(isKeepProtected("playwright", keepNames), false);
});

test("loadKeepNames respects --no-keep-file", () => {
  const fixture = makeOptimizeFixture();
  fs.writeFileSync(fixture.keepFile, "keep-me-file\n");

  const keepNames = loadKeepNames({
    keep: ["keep-me-cli"],
    keepFile: fixture.keepFile,
    useKeepFile: false,
  });

  assert.ok(isKeepProtected("keep-me-cli", keepNames));
  assert.equal(isKeepProtected("keep-me-file", keepNames), false);
});

// ---------------------------------------------------------
// 3. planOptimization tests & transaction boundaries
// ---------------------------------------------------------

test("planOptimization includes HIDE recommendations and excludes keep-protected skills", () => {
  const fixture = makeOptimizeFixture();
  const s1 = fixture.addSkill("heavy-unused", { frontmatter: { description: "Unused heavy" } });
  const s2 = fixture.addSkill("keep-me", { frontmatter: { description: "Keep me protected" } });

  const auditReport = {
    summary: { totalSkills: 2 },
    skills: [
      { skill: "heavy-unused", isModelVisible: true, visibleTokens: 250, isUsed: false, isStale: false },
      { skill: "keep-me", isModelVisible: true, visibleTokens: 300, isUsed: false, isStale: false },
    ],
  };

  const recReport = {
    recommendations: [
      { skill: "heavy-unused", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 250 },
      { skill: "keep-me", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 300 },
    ],
  };

  const skillsMap = new Map([
    ["root:heavy-unused", { skill: "heavy-unused", path: s1.skillPath, realPath: s1.skillPath }],
    ["root:keep-me", { skill: "keep-me", path: s2.skillPath, realPath: s2.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, {
    keep: ["keep-me"],
    stateDir: fixture.stateDir,
  });

  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].skill, "heavy-unused");
  assert.equal(plan.protectedByKeep.length, 1);
  assert.equal(plan.protectedByKeep[0].skill, "keep-me");
});

test("planOptimization unifies multiple symlinks to same realpath", () => {
  const fixture = makeOptimizeFixture();
  const target = fixture.addSkill("target-skill", { frontmatter: { description: "Shared target" } });

  const linkDir1 = path.join(fixture.root, "link1");
  const linkDir2 = path.join(fixture.root, "link2");
  fs.mkdirSync(linkDir1, { recursive: true });
  fs.mkdirSync(linkDir2, { recursive: true });
  const linkPath1 = path.join(linkDir1, "SKILL.md");
  const linkPath2 = path.join(linkDir2, "SKILL.md");
  fs.symlinkSync(target.skillPath, linkPath1);
  fs.symlinkSync(target.skillPath, linkPath2);

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "target-skill", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };

  const skillsMap = new Map([
    ["root1:target-skill", { skill: "target-skill", path: linkPath1, realPath: target.skillPath }],
    ["root2:target-skill", { skill: "target-skill", path: linkPath2, realPath: target.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  assert.equal(plan.planned.length, 1);
  assert.equal(plan.planned[0].observedPaths.length, 2);
  assert.equal(plan.planned[0].canonicalFilePath, target.skillPath);
});

test("planOptimization aborts target on CANONICAL_TARGET_CONFLICT when identities disagree", () => {
  const fixture = makeOptimizeFixture();
  const target = fixture.addSkill("shared-engine", { frontmatter: { description: "Multi identity" } });

  // Two different skill identities pointing to the same realpath
  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "shared-engine", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 150 },
      { skill: "alias-engine", action: "KEEP", confidence: "high", reasonCodes: ["RECENTLY_USED"], visibleTokens: 150 },
    ],
  };

  const skillsMap = new Map([
    ["root1:shared-engine", { skill: "shared-engine", path: target.skillPath, realPath: target.skillPath }],
    ["root2:alias-engine", { skill: "alias-engine", path: target.skillPath, realPath: target.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });

  // Neither should be modified because alias-engine is KEEP
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "CANONICAL_TARGET_CONFLICT");
  assert.match(plan.skipped[0].conflictDetails, /Identity alias-engine is KEEP, not HIDE/);
});

test("planOptimization skips duplicate installs with distinct realpaths (DUPLICATE_INSTALLATION)", () => {
  const fixture = makeOptimizeFixture();
  const s1 = fixture.addSkill("dupe-skill-1", { frontmatter: { description: "Copy 1" } });
  const s2 = fixture.addSkill("dupe-skill-2", { frontmatter: { description: "Copy 2" } });

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "dupe-skill", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };

  // Same skill name 'dupe-skill' installed in two different real paths
  const skillsMap = new Map([
    ["root1:dupe-skill", { skill: "dupe-skill", path: s1.skillPath, realPath: s1.skillPath }],
    ["root2:dupe-skill", { skill: "dupe-skill", path: s2.skillPath, realPath: s2.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 2);
  assert.equal(plan.skipped[0].reason, "DUPLICATE_INSTALLATION");
});

test("planOptimization skips already disabled skills (ALREADY_DISABLED)", () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("already-off", {
    frontmatter: {
      description: "Already off",
      "disable-model-invocation": "true",
    },
  });

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "already-off", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 0 },
    ],
  };

  const skillsMap = new Map([
    ["root:already-off", { skill: "already-off", path: s.skillPath, realPath: s.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  assert.equal(plan.planned.length, 0);
  assert.equal(plan.skipped.length, 1);
  assert.equal(plan.skipped[0].reason, "ALREADY_DISABLED");
});

// ---------------------------------------------------------
// 4. applyOptimization tests & rollback safety
// ---------------------------------------------------------

test("applyOptimization executes two-phase write and creates immutable manifest and backups", () => {
  const fixture = makeOptimizeFixture();
  const s1 = fixture.addSkill("test-skill-1", { frontmatter: { description: "First" } });
  const s2 = fixture.addSkill("test-skill-2", { frontmatter: { description: "Second" } });

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "test-skill-1", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
      { skill: "test-skill-2", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 150 },
    ],
  };
  const skillsMap = new Map([
    ["root:test-skill-1", { skill: "test-skill-1", path: s1.skillPath, realPath: s1.skillPath }],
    ["root:test-skill-2", { skill: "test-skill-2", path: s2.skillPath, realPath: s2.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  assert.equal(plan.planned.length, 2);

  const applyResult = applyOptimization(plan, { stateDir: fixture.stateDir });
  assert.equal(applyResult.success, true);
  assert.equal(applyResult.status, "applied");

  // Manifest created and contains entries
  const manifestFile = path.join(applyResult.runDir, "manifest.json");
  assert.ok(fs.existsSync(manifestFile));
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  assert.equal(manifest.type, "optimize");
  assert.equal(manifest.entries.length, 2);

  // Result file created
  const resultFile = path.join(applyResult.runDir, "result.json");
  assert.ok(fs.existsSync(resultFile));
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  assert.equal(result.status, "applied");
  assert.equal(result.appliedCount, 2);

  // Files modified on disk with disable-model-invocation: true
  const content1 = fs.readFileSync(s1.skillPath, "utf8");
  assert.match(content1, /disable-model-invocation: true/);
  const content2 = fs.readFileSync(s2.skillPath, "utf8");
  assert.match(content2, /disable-model-invocation: true/);

  // Backups exist in run directory
  assert.ok(fs.existsSync(path.join(applyResult.runDir, manifest.entries[0].backupFile)));
  assert.ok(fs.existsSync(path.join(applyResult.runDir, manifest.entries[1].backupFile)));
});

test("applyOptimization aborts immediately if hash drifted before apply (Phase 2 Pre-check)", () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("drift-skill", { frontmatter: { description: "Original" } });

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "drift-skill", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };
  const skillsMap = new Map([
    ["root:drift-skill", { skill: "drift-skill", path: s.skillPath, realPath: s.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });

  // Tamper with the file between plan and apply
  fs.appendFileSync(s.skillPath, "\n# Extra edit\n");

  const applyResult = applyOptimization(plan, { stateDir: fixture.stateDir });
  assert.equal(applyResult.success, false);
  assert.equal(applyResult.status, "aborted_rolled_back");
  assert.equal(applyResult.result.reason, "HASH_MISMATCH_BEFORE_APPLY");

  // File was not modified by optimizer
  const content = fs.readFileSync(s.skillPath, "utf8");
  assert.doesNotMatch(content, /disable-model-invocation: true/);
  assert.match(content, /# Extra edit/);
});

test("applyOptimization rolls back previously modified files when an error occurs during Phase 2 write", () => {
  const fixture = makeOptimizeFixture();
  const s1 = fixture.addSkill("rollback-1", { frontmatter: { description: "One" } });
  const s2 = fixture.addSkill("rollback-2", { frontmatter: { description: "Two" } });

  const s1Original = fs.readFileSync(s1.skillPath, "utf8");
  const s2Original = fs.readFileSync(s2.skillPath, "utf8");

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "rollback-1", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
      { skill: "rollback-2", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };
  const skillsMap = new Map([
    ["root:rollback-1", { skill: "rollback-1", path: s1.skillPath, realPath: s1.skillPath }],
    ["root:rollback-2", { skill: "rollback-2", path: s2.skillPath, realPath: s2.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });

  // Simulate write error on file 2 by making its parent dir read-only or invalidating it
  // More reliably: tamper with s2 file immediately after Phase 2 pre-check
  // Let's hook the buffer or delete s2 right before write
  fs.unlinkSync(s2.skillPath);

  const applyResult = applyOptimization(plan, { stateDir: fixture.stateDir });
  assert.equal(applyResult.success, false);
  assert.equal(applyResult.status, "aborted_rolled_back");

  // s1 was modified first, but then successfully rolled back to s1Original!
  const s1Current = fs.readFileSync(s1.skillPath, "utf8");
  assert.equal(s1Current, s1Original);
  assert.doesNotMatch(s1Current, /disable-model-invocation: true/);
});

// ---------------------------------------------------------
// 5. restoreOptimizationRun tests & anti-conflict protection
// ---------------------------------------------------------

test("restoreOptimizationRun restores original content byte-exact", () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("undo-test", { frontmatter: { description: "Undoable" } });
  const originalBytes = fs.readFileSync(s.skillPath);

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "undo-test", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };
  const skillsMap = new Map([
    ["root:undo-test", { skill: "undo-test", path: s.skillPath, realPath: s.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  const applyResult = applyOptimization(plan, { stateDir: fixture.stateDir });

  assert.match(fs.readFileSync(s.skillPath, "utf8"), /disable-model-invocation: true/);

  // Restore
  const undoResult = restoreOptimizationRun(fixture.stateDir, applyResult.runId);
  assert.equal(undoResult.status, "restored");
  assert.equal(undoResult.restored.length, 1);
  assert.equal(undoResult.restored[0], "undo-test");

  // File is restored byte-exact
  const restoredBytes = fs.readFileSync(s.skillPath);
  assert.deepEqual(restoredBytes, originalBytes);

  // restore.json was created
  const restoreFile = path.join(applyResult.runDir, "restore.json");
  assert.ok(fs.existsSync(restoreFile));
});

test("restoreOptimizationRun detects user edits after optimize and skips with CONFLICT_AFTER_OPTIMIZE", () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("conflict-test", { frontmatter: { description: "Conflict" } });

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "conflict-test", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };
  const skillsMap = new Map([
    ["root:conflict-test", { skill: "conflict-test", path: s.skillPath, realPath: s.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  const applyResult = applyOptimization(plan, { stateDir: fixture.stateDir });

  // User edits the file after optimize was applied!
  fs.appendFileSync(s.skillPath, "\n# User manual edit after optimization\n");
  const userEditedContent = fs.readFileSync(s.skillPath, "utf8");

  // Try to restore
  const undoResult = restoreOptimizationRun(fixture.stateDir, applyResult.runId);
  assert.equal(undoResult.status, "restored");
  assert.equal(undoResult.restored.length, 0);
  assert.equal(undoResult.conflicts.length, 1);
  assert.equal(undoResult.conflicts[0].reason, "CONFLICT_AFTER_OPTIMIZE");
  assert.ok(fs.existsSync(undoResult.conflicts[0].backupFile));

  // User edit was NOT overwritten
  assert.equal(fs.readFileSync(s.skillPath, "utf8"), userEditedContent);
});

test("restoreOptimizationRun returns ALREADY_RESTORED on subsequent undo calls", () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("repeat-undo", { frontmatter: { description: "Repeat" } });

  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "repeat-undo", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };
  const skillsMap = new Map([
    ["root:repeat-undo", { skill: "repeat-undo", path: s.skillPath, realPath: s.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  const applyResult = applyOptimization(plan, { stateDir: fixture.stateDir });

  const undo1 = restoreOptimizationRun(fixture.stateDir, applyResult.runId);
  assert.equal(undo1.status, "restored");

  // Second undo
  const undo2 = restoreOptimizationRun(fixture.stateDir, applyResult.runId);
  assert.equal(undo2.status, "ALREADY_RESTORED");
});

// ---------------------------------------------------------
// 6. CLI Integration tests
// ---------------------------------------------------------

test("CLI optimize dry-run outputs planned actions and does not modify files", async () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("dry-run-skill", { frontmatter: { description: "Dry run test" } });
  const beforeContent = fs.readFileSync(s.skillPath, "utf8");

  let stdout = "";
  await main(fixture.cliArgs(["optimize"]), {
    stdout: { write: (chunk) => (stdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.match(stdout, /Skill Context Doctor - Optimize \(Dry Run\)/);
  assert.match(stdout, /Skills to hide:/);
  assert.match(stdout, /No files changed\. Run with --apply to execute\./);

  // File is untouched
  const afterContent = fs.readFileSync(s.skillPath, "utf8");
  assert.equal(afterContent, beforeContent);
});

test("CLI optimize --apply modifies file and undo latest restores it", async () => {
  const fixture = makeOptimizeFixture();
  const s = fixture.addSkill("cli-apply-skill", { frontmatter: { description: "Apply test" } });
  const originalContent = fs.readFileSync(s.skillPath, "utf8");

  let applyStdout = "";
  await main(fixture.cliArgs(["optimize", "--apply"]), {
    stdout: { write: (chunk) => (applyStdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.match(applyStdout, /Skill Context Doctor - Optimize \(Executed\)/);
  assert.match(applyStdout, /Modified \(HIDE\):\s+1/);
  assert.match(fs.readFileSync(s.skillPath, "utf8"), /disable-model-invocation: true/);

  // Undo latest
  let undoStdout = "";
  await main(["undo", "latest", "--state-dir", fixture.stateDir], {
    stdout: { write: (chunk) => (undoStdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.match(undoStdout, /Restored 1 skills from optimize run/);
  assert.equal(fs.readFileSync(s.skillPath, "utf8"), originalContent);
});

test("CLI optimize --json outputs structured plan", async () => {
  const fixture = makeOptimizeFixture();
  fixture.addSkill("json-skill", { frontmatter: { description: "Json test" } });

  let stdout = "";
  await main(fixture.cliArgs(["optimize", "--json"]), {
    stdout: { write: (chunk) => (stdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.command, "optimize");
  assert.ok(Array.isArray(parsed.planned));
  assert.equal(typeof parsed.summary.plannedCount, "number");
});

test("CLI optimize --source pi uses global evidence scope", async () => {
  const fixture = makeOptimizeFixture();
  fixture.addSkill("scope-skill", { frontmatter: { description: "Scope test" } });

  let stdout = "";
  const plan = await main(fixture.cliArgs(["optimize", "--source", "pi", "--json"]), {
    stdout: { write: (chunk) => (stdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.equal(plan.analysisScope, "all");
  assert.equal(plan.displaySource, "pi");
});

test("CLI optimize --only targets exclusively the specified skill", async () => {
  const fixture = makeOptimizeFixture();
  fixture.addSkill("skill-alpha", { frontmatter: { description: "Alpha" } });
  fixture.addSkill("skill-beta", { frontmatter: { description: "Beta" } });

  let stdout = "";
  const plan = await main(fixture.cliArgs(["optimize", "--only", "skill-alpha", "--json"]), {
    stdout: { write: (chunk) => (stdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.equal(plan.summary.plannedCount, 1);
  assert.equal(plan.planned[0].skill, "skill-alpha");
});

test("CLI optimize --limit limits planned targets to specified count", async () => {
  const fixture = makeOptimizeFixture();
  fixture.addSkill("skill-one", { frontmatter: { description: "One" } });
  fixture.addSkill("skill-two", { frontmatter: { description: "Two" } });
  fixture.addSkill("skill-three", { frontmatter: { description: "Three" } });

  let stdout = "";
  const plan = await main(fixture.cliArgs(["optimize", "--limit", "2", "--json"]), {
    stdout: { write: (chunk) => (stdout += chunk) },
    now: new Date("2026-09-22T12:00:00.000Z"),
  });

  assert.equal(plan.summary.plannedCount, 2);
  assert.equal(plan.planned.length, 2);
});

test("planOptimization sorts deterministically by token savings DESC and skill name ASC as tie-breaker", () => {
  const auditReport = { summary: {} };
  const recReport = {
    recommendations: [
      { skill: "zebra", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
      { skill: "apple", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
      { skill: "mango", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 200 },
      { skill: "banana", action: "HIDE", confidence: "high", reasonCodes: ["VISIBLE_NEVER_USED"], visibleTokens: 100 },
    ],
  };

  const fixture = makeOptimizeFixture();
  const z = fixture.addSkill("zebra", { frontmatter: { description: "Z" } });
  const a = fixture.addSkill("apple", { frontmatter: { description: "A" } });
  const m = fixture.addSkill("mango", { frontmatter: { description: "M" } });
  const b = fixture.addSkill("banana", { frontmatter: { description: "B" } });

  const skillsMap = new Map([
    ["root:zebra", { skill: "zebra", path: z.skillPath, realPath: z.skillPath }],
    ["root:apple", { skill: "apple", path: a.skillPath, realPath: a.skillPath }],
    ["root:mango", { skill: "mango", path: m.skillPath, realPath: m.skillPath }],
    ["root:banana", { skill: "banana", path: b.skillPath, realPath: b.skillPath }],
  ]);

  const plan = planOptimization(auditReport, recReport, skillsMap, { stateDir: fixture.stateDir });
  assert.equal(plan.planned.length, 4);

  // Highest token savings first (mango: 200)
  assert.equal(plan.planned[0].skill, "mango");
  // Tie-breaker: 100 tokens sorted alphabetically (apple, banana, zebra)
  assert.equal(plan.planned[1].skill, "apple");
  assert.equal(plan.planned[2].skill, "banana");
  assert.equal(plan.planned[3].skill, "zebra");
});
