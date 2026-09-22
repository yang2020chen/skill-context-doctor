import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./args.js";

function splitNames(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readKeepFile(file) {
  if (!file) return [];
  const resolved = path.resolve(expandHome(file));
  if (!fs.existsSync(resolved)) return [];
  try {
    return fs
      .readFileSync(resolved, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .flatMap(splitNames);
  } catch {
    return [];
  }
}

/**
 * Loads exact skill names protected from optimization.
 * Combines --keep CLI options and the persistent keep file.
 *
 * @param {object} options Command options
 * @returns {Set<string>} Set of exact skill names
 */
export function loadKeepNames(options = {}) {
  const names = new Set();

  if (!options.noKeepFile && options.useKeepFile !== false) {
    const keepFile = options.keepFile || "~/.config/skill-context-doctor/keep";
    for (const name of readKeepFile(keepFile)) {
      names.add(name);
    }
  }

  const cliKeep =
    options.keep ||
    options.keepPatterns ||
    options.keepNames ||
    [];
  for (const item of Array.isArray(cliKeep) ? cliKeep : [cliKeep]) {
    for (const name of splitNames(item)) {
      names.add(name);
    }
  }

  return names;
}

/**
 * Checks if a skill is protected by the keep whitelist.
 * Uses exact equality matching (no globbing in v0.3.0).
 *
 * @param {string} skillName Skill name
 * @param {Set<string>} keepNames Set of exact protected names
 * @returns {boolean} True if protected
 */
export function isKeepProtected(skillName, keepNames) {
  if (!skillName || !keepNames) return false;
  return keepNames.has(skillName);
}

/**
 * Appends an exact skill name to the persistent keep file.
 *
 * @param {object} options Command options
 * @param {string} name Skill name to append
 * @returns {object} Result object
 */
export function appendKeepName(options, name) {
  if (options.noKeepFile) {
    return { saved: false, alreadyPresent: false, file: "", name };
  }
  const keepFile = path.resolve(expandHome(options.keepFile || "~/.config/skill-context-doctor/keep"));
  let existing = "";
  try {
    existing = fs.existsSync(keepFile) ? fs.readFileSync(keepFile, "utf8") : "";
  } catch {
    existing = "";
  }

  const alreadyPresent = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap(splitNames)
    .includes(name);

  if (alreadyPresent) {
    return { saved: true, alreadyPresent: true, file: keepFile, name };
  }

  fs.mkdirSync(path.dirname(keepFile), { recursive: true });
  const needsLeadingNewline = existing.length > 0 && !existing.endsWith("\n");
  fs.appendFileSync(keepFile, `${needsLeadingNewline ? "\n" : ""}${name}\n`);
  return { saved: true, alreadyPresent: false, file: keepFile, name };
}
