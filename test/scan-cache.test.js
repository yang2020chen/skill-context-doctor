import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createScanCache,
  fileFingerprint,
  inventorySignature,
} from "../src/scan-cache.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skillkill-cache-test-"));
  const stateDir = path.join(root, "state");
  const history = path.join(root, "history.jsonl");
  fs.writeFileSync(history, "{}\n");
  const skills = new Map([
    ["root:demo", {
      id: "root:demo",
      skill: "demo",
      path: "/skills/demo/SKILL.md",
      realPath: "/skills/demo/SKILL.md",
      usageEvents: [],
      mentions: [],
    }],
  ]);
  return { history, root, skills, stateDir };
}

test("partitions unchanged files and replays captured evidence with Date timestamps", () => {
  const { history, skills, stateDir } = fixture();
  const first = createScanCache(skills, { stateDir });
  const partition = first.partitionFiles("codex", "jsonl", [history]);
  assert.deepEqual(partition.dirty, [history]);
  assert.equal(partition.cached.length, 0);

  const baseline = first.snapshot();
  skills.get("root:demo").usageEvents.push({
    kind: "codex_skill_block",
    source: `${history}:1`,
    sourceFile: history,
    sourceLine: 1,
    ts: new Date("2026-07-12T10:00:00Z"),
  });
  skills.get("root:demo").mentions.push({
    kind: "codex_path_reference",
    source: `${history}:2`,
    sourceFile: history,
    sourceLine: 2,
    ts: new Date("2026-07-12T10:01:00Z"),
  });
  first.capture({ source: "codex", kind: "jsonl", files: partition.dirty, baselines: baseline });
  first.commit();

  const freshSkills = new Map([["root:demo", { ...skills.get("root:demo"), usageEvents: [], mentions: [] }]]);
  const second = createScanCache(freshSkills, { stateDir });
  const warm = second.partitionFiles("codex", "jsonl", [history]);
  assert.equal(warm.dirty.length, 0);
  assert.equal(warm.cached.length, 1);
  assert.equal(second.replay(warm.cached), 2);
  assert.equal(freshSkills.get("root:demo").usageEvents[0].kind, "codex_skill_block");
  assert.equal(freshSkills.get("root:demo").mentions[0].kind, "codex_path_reference");
  assert.ok(freshSkills.get("root:demo").usageEvents[0].ts instanceof Date);
});

test("invalidates changed and removed files", () => {
  const { history, skills, stateDir } = fixture();
  const cache = createScanCache(skills, { stateDir });
  cache.capture({ source: "codex", kind: "jsonl", files: [history], baselines: cache.snapshot() });
  cache.commit();

  fs.appendFileSync(history, "{}\n");
  const changed = createScanCache(skills, { stateDir });
  assert.deepEqual(changed.partitionFiles("codex", "jsonl", [history]).dirty, [history]);
  changed.commit();

  const removed = createScanCache(skills, { stateDir });
  removed.partitionFiles("codex", "jsonl", []);
  removed.commit();
  const document = JSON.parse(fs.readFileSync(path.join(stateDir, "scan-cache-v1.json"), "utf8"));
  assert.deepEqual(document.modes.prefilter.files, {});
});

test("separates full scan mode and invalidates a changed skill inventory", () => {
  const { history, skills, stateDir } = fixture();
  const normal = createScanCache(skills, { stateDir });
  normal.capture({ source: "codex", kind: "jsonl", files: [history], baselines: normal.snapshot() });
  normal.commit();

  const full = createScanCache(skills, { stateDir, fullScan: true });
  assert.deepEqual(full.partitionFiles("codex", "jsonl", [history]).dirty, [history]);
  full.capture({ source: "codex", kind: "jsonl", files: [history], baselines: full.snapshot() });
  full.commit();
  assert.equal(createScanCache(skills, { stateDir }).partitionFiles("codex", "jsonl", [history]).cached.length, 1);

  const expanded = new Map(skills);
  expanded.set("root:new", {
    id: "root:new",
    skill: "new",
    path: "/skills/new/SKILL.md",
    realPath: "/skills/new/SKILL.md",
    usageEvents: [],
    mentions: [],
  });
  assert.notEqual(inventorySignature(skills), inventorySignature(expanded));
  assert.deepEqual(createScanCache(expanded, { stateDir }).partitionFiles("codex", "jsonl", [history]).dirty, [history]);
});

test("falls back from malformed cache and commits atomically with private permissions", () => {
  const { history, skills, stateDir } = fixture();
  fs.mkdirSync(stateDir, { recursive: true });
  const cacheFile = path.join(stateDir, "scan-cache-v1.json");
  fs.writeFileSync(cacheFile, "not-json");

  const cache = createScanCache(skills, { stateDir });
  assert.deepEqual(cache.partitionFiles("codex", "jsonl", [history]).dirty, [history]);
  cache.capture({ source: "codex", kind: "jsonl", files: [history], baselines: cache.snapshot() });
  cache.commit();

  assert.equal(fs.statSync(cacheFile).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(stateDir).filter((file) => file.endsWith(".tmp")).length, 0);
  assert.deepEqual(fileFingerprint("/missing/file"), null);
});
