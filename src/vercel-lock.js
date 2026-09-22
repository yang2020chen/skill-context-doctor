import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GLOBAL_LOCK_FILE = ".skill-lock.json";
const LOCAL_LOCK_FILE = "skills-lock.json";
const CURRENT_GLOBAL_VERSION = 3;

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function getVercelGlobalLockPath(env = process.env, home = os.homedir()) {
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "skills", GLOBAL_LOCK_FILE);
  return path.join(home, ".agents", GLOBAL_LOCK_FILE);
}

function inferredLocalLockPath(skillsDir) {
  if (!skillsDir) return "";
  const resolved = path.resolve(skillsDir);
  const skillsBase = path.basename(resolved);
  const agentsBase = path.basename(path.dirname(resolved));
  if (skillsBase !== "skills" || agentsBase !== ".agents") return "";
  const projectRoot = path.dirname(path.dirname(resolved));
  if (projectRoot === os.homedir()) return "";
  return path.join(projectRoot, LOCAL_LOCK_FILE);
}

export function getVercelLockPaths(options = {}) {
  const globalLock = getVercelGlobalLockPath();
  const localLocks = (options.skillsDirs || [options.skillsDir]).map((skillsDir) =>
    inferredLocalLockPath(skillsDir),
  );
  return unique([globalLock, ...localLocks]);
}

function readLockFile(lockPath) {
  if (!lockPath || !fs.existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !parsed.skills || typeof parsed.skills !== "object") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeLockFile(lockPath, lock) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

export function removeSkillsFromVercelLocks(skillNames, options = {}) {
  const names = new Set(skillNames);
  const entriesBySkill = new Map();
  const removed = [];
  const errors = [];

  for (const lockPath of getVercelLockPaths(options)) {
    const lock = readLockFile(lockPath);
    if (!lock) continue;

    let changed = false;
    for (const skillName of names) {
      const entry = lock.skills[skillName];
      if (!entry) continue;

      const lockedEntry = {
        lockPath,
        version: typeof lock.version === "number" ? lock.version : CURRENT_GLOBAL_VERSION,
        skill: skillName,
        entry,
      };
      const existing = entriesBySkill.get(skillName) || [];
      existing.push(lockedEntry);
      entriesBySkill.set(skillName, existing);
      removed.push(lockedEntry);
      delete lock.skills[skillName];
      changed = true;
    }

    if (!changed) continue;
    try {
      writeLockFile(lockPath, lock);
    } catch (error) {
      errors.push({
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { entriesBySkill, removed, errors };
}

export function restoreVercelLockEntries(entries = []) {
  const restored = [];
  const errors = [];
  const byLockPath = new Map();

  for (const item of entries) {
    if (!item?.lockPath || !item.skill || !item.entry) continue;
    const existing = byLockPath.get(item.lockPath) || [];
    existing.push(item);
    byLockPath.set(item.lockPath, existing);
  }

  for (const [lockPath, items] of byLockPath) {
    const lock = readLockFile(lockPath) || {
      version: items[0]?.version || CURRENT_GLOBAL_VERSION,
      skills: {},
    };

    for (const item of items) {
      if (!lock.skills[item.skill]) {
        lock.skills[item.skill] = item.entry;
        restored.push(item);
      }
    }

    try {
      writeLockFile(lockPath, lock);
    } catch (error) {
      errors.push({
        lockPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { restored, errors };
}
