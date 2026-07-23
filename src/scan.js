import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { existingRoots, jsonStrings, shellQuote, sourceLabel, walkFiles, withinRoot } from "./fs-utils.js";
import { ageDays, timestampFromRecord } from "./model.js";

const SKILL_BLOCK_RE =
  /<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>[\s\S]*?<\/skill>/g;
const DOT_SKILL_PATH_RE =
  /(?<path>(?:~|\/[^"'<>\s]+)?\/\.(?:agents|claude|codex|cursor)\/skills\/(?<name>[^\/"'<>\s]+)\/SKILL\.md)/g;
const RELATIVE_DOT_SKILL_PATH_RE =
  /(?<path>(?:\.(?:agents|claude|codex|cursor)|\$(?:\{HOME\}|HOME)\/\.(?:agents|claude|codex|cursor))\/skills\/(?<name>[^\/"'<>\s]+)\/SKILL\.md)/g;
const BARE_SKILL_PATH_RE =
  /\/skills\/(?<name>[^\/"<>\s]+)\/SKILL\.md/g;
const BARE_SKILL_SCRIPT_RE =
  /\/skills\/(?<name>[^\/"<>\s]+)\/scripts\//g;
const CANONICAL_DOT_SKILL_PATH_RE =
  /(?:^|\/)\.(?:agents|claude|codex|cursor)\/skills\/(?<name>[^/]+)\/SKILL\.md$/;
const CODEX_PLUGIN_SKILL_PATH_RE =
  /(?<path>(?:~|\/[^"'<>\s]+)?\/\.codex\/plugins\/cache\/[^"'<>\s]+\/(?<name>[^\/"'<>\s]+)\/SKILL\.md)/g;
const READ_TOOL_NAMES = new Set([
  "cat",
  "grep",
  "open",
  "openfile",
  "read",
  "readfile",
  "rg",
  "view",
]);
const READ_COMMAND_PATTERN = String.raw`(?:cat|sed|head|tail|less|more|bat|batcat|nl|awk|grep|rg)`;
const READ_COMMAND_RE = new RegExp(
  String.raw`\b${READ_COMMAND_PATTERN}\b[\s\S]*\/SKILL\.md\b`,
);
const COMMAND_NAME_RE = /<command-name>([^<]+)<\/command-name>/g;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function skillDirs(value) {
  return (Array.isArray(value) ? value : [value]).filter(Boolean);
}

function isKnownDotSkillRoot(skillsDir) {
  return /\/\.(?:agents|claude|codex|cursor)\/skills$/.test(path.resolve(skillsDir));
}

function dynamicSkillPathRes(skillsDirs) {
  return skillDirs(skillsDirs)
    .filter((skillsDir) => !isKnownDotSkillRoot(skillsDir))
    .map(
      (skillsDir) =>
        new RegExp(
          `(?<path>${escapeRegExp(skillsDir)}\\/(?<name>[^\\/"'<>\\s]+)\\/SKILL\\.md)`,
          "g",
        ),
    );
}

function dynamicSkillPathPatterns(skillsDirs) {
  return skillDirs(skillsDirs)
    .filter((skillsDir) => !isKnownDotSkillRoot(skillsDir))
    .map((skillsDir) => `${escapeRegExp(skillsDir)}\\/[^\\/"'<>\\s]+\\/SKILL\\.md`);
}

function skillPathSearchPattern(skillsDirs) {
  return [
    String.raw`(?:~|/[^"'<>\s]+)?/\.(?:agents|claude|codex|cursor)/skills/[^/"'<>\s]+/SKILL\.md`,
    String.raw`(?:\.(?:agents|claude|codex|cursor)|\$(?:\{HOME\}|HOME)/\.(?:agents|claude|codex|cursor))/skills/[^/"'<>\s]+/SKILL\.md`,
    String.raw`(?:~|/[^"'<>\s]+)?/\.codex/plugins/cache/.*/[^/"'<>\s]+/SKILL\.md`,
    ...dynamicSkillPathPatterns(skillsDirs),
  ]
    .filter(Boolean)
    .join("|");
}

function installedSkillPathSearchPattern(skills) {
  const paths = new Set();
  const names = new Set();
  for (const usage of skills.values()) {
    paths.add(usage.path);
    paths.add(usage.realPath);
    names.add(usage.skill);
    const home = process.env.HOME || "";
    if (home && usage.path.startsWith(`${home}${path.sep}`)) {
      paths.add(`~${usage.path.slice(home.length)}`);
    }
  }
  const exactPaths = [...paths].filter(Boolean).map(escapeRegExp);
  const exactNames = [...names].filter(Boolean).map(escapeRegExp).join("|");
  const relativePaths = exactNames
    ? [
        String.raw`(?:\.(?:agents|claude|codex|cursor)|\$(?:\{HOME\}|HOME)/\.(?:agents|claude|codex|cursor))/skills/(?:${exactNames})/SKILL\.md`,
      ]
    : [];
  return [...exactPaths, ...relativePaths].join("|");
}

function installedSkillFixedPatterns(skills) {
  const patterns = new Set();
  for (const usage of skills.values()) {
    patterns.add(`/skills/${usage.skill}/SKILL.md`);
    patterns.add(`/skills/${usage.skill}/scripts/`);
    patterns.add(`<command-name>${usage.skill}</command-name>`);
  }
  return [...patterns].filter(Boolean);
}

function installedSkillRawMatcher(skills) {
  const names = new Set();
  for (const usage of skills.values()) {
    names.add(usage.skill);
  }
  return (text) => {
    if (!text.includes("SKILL.md") && !text.includes("/scripts/") && !text.includes("<command-name>")) {
      return false;
    }
    for (const match of text.matchAll(/\/skills\/([^\/"'<>\s]+)\/(?:SKILL\.md|scripts\/)/g)) {
      if (names.has(match[1])) return true;
    }
    const commandName = text.match(/<command-name>([^<]+)<\/command-name>/);
    return commandName ? names.has(commandName[1]?.trim()) : false;
  };
}

function skillScriptSearchPattern(skills) {
  const variants = new Set();
  for (const usage of skills.values()) {
    variants.add(path.join(path.dirname(usage.path), "scripts") + path.sep);
    if (usage.realPath) variants.add(path.join(path.dirname(usage.realPath), "scripts") + path.sep);
  }
  return [...variants].map(escapeRegExp).join("|");
}

function sourcePointer(file, lineNo) {
  return lineNo ? `${sourceLabel(file)}:${lineNo}` : sourceLabel(file);
}

function cleanTitle(value) {
  const title = String(value || "").trim().replace(/\s+/g, " ");
  if (!title || title.length > 120) return "";
  return title;
}

function recordTitle(record) {
  if (!record || typeof record !== "object") return "";
  return (
    cleanTitle(record.title) ||
    cleanTitle(record.chatTitle) ||
    cleanTitle(record.conversationTitle) ||
    cleanTitle(record.sessionTitle) ||
    cleanTitle(record.metadata?.title) ||
    cleanTitle(record.session?.title) ||
    cleanTitle(record.conversation?.title) ||
    cleanTitle(record.payload?.title)
  );
}

function fileTitle(file) {
  const parsed = path.parse(file);
  if (["conversation", "message", "part", "store"].includes(parsed.name)) {
    return path.basename(path.dirname(file)) || parsed.name;
  }
  return parsed.name || path.basename(file);
}

function chatTitle(record, file) {
  return recordTitle(record) || fileTitle(file);
}

function codexUsageText(record, rawLine) {
  if (!record) return rawLine;
  const payloadType = record.payload?.type;
  if (["custom_tool_call_output", "function_call_output"].includes(payloadType)) return "";
  if (["custom_tool_call", "function_call"].includes(payloadType)) {
    return jsonStrings(record.payload?.input ?? record.payload?.arguments).join("\n");
  }
  return jsonStrings(record).join("\n");
}

function claudeUsageText(record, rawLine) {
  if (!record) return rawLine;
  const values = [];
  if (typeof record.command === "string") values.push(record.command);
  if (record.input !== undefined) jsonStrings(record.input, values);
  if (typeof record.message === "string") values.push(record.message);

  const visitContent = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visitContent);
      return;
    }
    if (!value || typeof value !== "object" || value.type === "tool_result") return;
    if (value.type === "tool_use") {
      jsonStrings(value.input, values);
      return;
    }
    if (value.type === "text" && typeof value.text === "string") values.push(value.text);
    Object.values(value).forEach(visitContent);
  };
  visitContent(record.message?.content);
  return values.join("\n");
}

function fileTimestamp(file) {
  try {
    return fs.statSync(file).mtime;
  } catch {
    return null;
  }
}

function fileCreatedAt(file) {
  try {
    const stat = fs.statSync(file);
    return stat.birthtime?.getTime() > 0 ? stat.birthtime : stat.mtime;
  } catch {
    return null;
  }
}

function jsonlStartTimestamp(file) {
  try {
    const firstLine = fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .find((line) => line.trim().length > 0);
    if (!firstLine) return fileCreatedAt(file);
    return timestampFromRecord(JSON.parse(firstLine)) || fileCreatedAt(file);
  } catch {
    return fileCreatedAt(file);
  }
}

function jsonStartTimestamp(file) {
  const parsed = readJsonFile(file);
  if (!parsed) return fileCreatedAt(file);
  if (Array.isArray(parsed)) {
    return parsed
      .filter((record) => record && typeof record === "object")
      .map(timestampFromRecord)
      .find(Boolean) || fileCreatedAt(file);
  }
  return timestampFromRecord(parsed) || fileCreatedAt(file);
}

function isRecentTimestamp(value, options) {
  if (!value) return false;
  return ageDays(value, options.now || new Date()) <= (options.savingsDays ?? 30);
}

function countRecentFiles(roots, predicate, timestampOf, options) {
  const files = new Set(
    existingRoots(roots).flatMap((root) => walkFiles(root, predicate)),
  );
  return [...files].filter((file) => isRecentTimestamp(timestampOf(file), options)).length;
}

function countRecentChildDirs(roots, options) {
  const dirs = new Set();
  for (const root of existingRoots(roots)) {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.add(path.join(root, entry.name));
    }
  }
  return [...dirs].filter((dir) => isRecentTimestamp(fileCreatedAt(dir), options)).length;
}

function addRecentChats(stats, source, count) {
  stats[source].recentNewChats += count;
  stats.recentNewChats += count;
}

function unquoteFrontmatterValue(value) {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === `"` && last === `"`) || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};

  const metadata = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) continue;

    const [, key, rawValue] = field;
    if (/^[>|]/.test(rawValue.trim())) {
      const block = [];
      for (index += 1; index < lines.length; index += 1) {
        if (!/^\s+/.test(lines[index])) {
          index -= 1;
          break;
        }
        block.push(lines[index].trim());
      }
      metadata[key] = rawValue.trim().startsWith("|") ? block.join("\n") : block.join(" ");
      continue;
    }

    metadata[key] = unquoteFrontmatterValue(rawValue);
  }
  return metadata;
}

function readSkillMetadata(file) {
  try {
    return parseFrontmatter(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function addStrategy(stats, strategy) {
  if (stats.strategy === "not-run") {
    stats.strategy = strategy;
    return;
  }
  if (!stats.strategy.split("+").includes(strategy)) {
    stats.strategy = `${stats.strategy}+${strategy}`;
  }
}

function attributionSkills(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => attributionSkills(item, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;

  for (const [key, item] of Object.entries(value)) {
    if (key === "attributionSkill" && typeof item === "string") {
      out.push(item);
      continue;
    }
    attributionSkills(item, out);
  }
  return out;
}

function normalizedToolName(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/[^a-z0-9]/g, "") : "";
}

function structuredToolName(record) {
  return (
    record.tool ??
    (record.type === "tool_use" ? record.name : undefined) ??
    record.name ??
    record.toolName ??
    record.providerToolName ??
    record.function?.name ??
    record.toolCall?.name ??
    record.toolCall?.toolName ??
    record.toolCall?.function?.name
  );
}

function maybeJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function expandPathText(value) {
  if (typeof value !== "string") return "";
  if (value.startsWith("${HOME}/")) {
    return path.join(process.env.HOME || "", value.slice(8));
  }
  if (value.startsWith("$HOME/")) {
    return path.join(process.env.HOME || "", value.slice(6));
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "", value.slice(2));
  }
  return value;
}

function realPathOrResolve(value) {
  const expanded = expandPathText(value);
  try {
    return fs.realpathSync(expanded);
  } catch {
    return path.resolve(expanded);
  }
}

function structuredToolInput(record) {
  return [
    record.input,
    record.args,
    record.arguments,
    record.params,
    record.state?.input,
    record.function?.arguments,
    record.toolCall?.input,
    record.toolCall?.args,
    record.toolCall?.arguments,
    record.toolCall?.function?.arguments,
  ].map(maybeJson);
}

function structuredReadToolCalls(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => structuredReadToolCalls(item, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;

  const toolName = normalizedToolName(structuredToolName(value));
  if (READ_TOOL_NAMES.has(toolName)) {
    out.push(value);
  }

  Object.values(value).forEach((item) => structuredReadToolCalls(item, out));
  return out;
}

function structuredSkillToolCalls(value, out = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => structuredSkillToolCalls(item, out));
    return out;
  }
  if (!value || typeof value !== "object") return out;

  if (normalizedToolName(structuredToolName(value)) === "skill") {
    out.push(value);
  }

  Object.values(value).forEach((item) => structuredSkillToolCalls(item, out));
  return out;
}

export function listSkillFiles(skillsDir) {
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({
      name: entry.name,
      root: skillsDir,
      file: path.join(skillsDir, entry.name, "SKILL.md"),
    }))
    .filter((entry) => fs.existsSync(entry.file));
}

function directoryFingerprint(root) {
  const hash = crypto.createHash("sha256");
  const files = walkFiles(root, () => true)
    .map((file) => path.relative(root, file))
    .sort();
  for (const file of files) {
    const fullPath = path.join(root, file);
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(fullPath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function collectSkills(skillsDirs) {
  const skills = new Map();
  for (const entry of skillDirs(skillsDirs).flatMap((skillsDir) => listSkillFiles(skillsDir))) {
    const stat = fs.statSync(entry.file);
    const skillDir = path.dirname(entry.file);
    const linkStat = fs.lstatSync(skillDir);
    const isSymlink = linkStat.isSymbolicLink();
    const metadata = readSkillMetadata(entry.file);
    const id = `${entry.root}:${entry.name}`;
    skills.set(id, {
      id,
      skill: entry.name,
      installRoot: entry.root,
      path: entry.file,
      realPath: realPathOrResolve(entry.file),
      managedByPluginCache: entry.file.includes(`${path.sep}.codex${path.sep}plugins${path.sep}cache${path.sep}`),
      isSymlink,
      linkTarget: isSymlink ? fs.realpathSync(skillDir) : "",
      fingerprint: directoryFingerprint(skillDir),
      description: typeof metadata.description === "string" ? metadata.description : "",
      atime: stat.atime,
      birthtime: isSymlink ? linkStat.birthtime : stat.birthtime,
      mtime: stat.mtime,
      usageEvents: [],
      mentions: [],
    });
  }
  return skills;
}

function addEvidence(skills, name, evidence, usageEvent) {
  const matches = [...skills.values()].filter((usage) => usage.skill === name);
  for (const usage of matches) {
    (usageEvent ? usage.usageEvents : usage.mentions).push(evidence);
  }
  return matches.length > 0;
}

function addPathEvidence(skills, skillsDirs, pathText, fallbackName, evidence, usageEvent) {
  const file = expandPathText(pathText);
  if (!skillDirs(skillsDirs).some((skillsDir) => withinRoot(file, skillsDir))) {
    const canonical = file.match(CANONICAL_DOT_SKILL_PATH_RE);
    if (canonical?.groups?.name) {
      return addEvidence(skills, fallbackName || canonical.groups.name, evidence, usageEvent);
    }
    return false;
  }
  const realFile = realPathOrResolve(file);
  const exact = [...skills.values()].find(
    (usage) => path.resolve(usage.path) === path.resolve(file) || usage.realPath === realFile,
  );
  if (exact) {
    (usageEvent ? exact.usageEvents : exact.mentions).push(evidence);
    return true;
  }
  const name = path.basename(path.dirname(file)) || fallbackName;
  return addEvidence(skills, name, evidence, usageEvent);
}

function addSkillIdentityEvidence(skills, skillsDirs, pathText, fallbackName, evidence, usageEvent) {
  const file = expandPathText(pathText);
  const canonical = file.match(CANONICAL_DOT_SKILL_PATH_RE);
  const name =
    skillDirs(skillsDirs).some((skillsDir) => withinRoot(file, skillsDir))
      ? path.basename(path.dirname(file))
      : canonical?.groups?.name || fallbackName;
  return name ? addEvidence(skills, name, evidence, usageEvent) : false;
}

function addSkillPathReferences(skills, options, text, context) {
  const roots = options.skillsDirs || options.skillsDir;
  const customPathRes = dynamicSkillPathRes(roots);
  const usageEvent = Boolean(context.usageEvent);
  const seenPathRefs = new Set();
  let count = 0;

  for (const match of text.matchAll(DOT_SKILL_PATH_RE)) {
    if (match.index > 0 && /[A-Za-z0-9_$}]/.test(text[match.index - 1])) continue;
    const name = context.aliases?.get(match.groups.name) || match.groups.name;
    const key = `${name}:${match.groups.path}`;
    if (seenPathRefs.has(key)) continue;
    seenPathRefs.add(key);
    if (
      addPathEvidence(
        skills,
        roots,
        match.groups.path,
        name,
        {
          ts: context.ts,
          kind: context.kind,
          source: context.source,
          sourceFile: context.sourceFile,
          sourceLine: context.sourceLine,
          chatTitle: context.chatTitle,
        },
        usageEvent,
      )
    ) {
      count += 1;
    }
  }

  for (const match of text.matchAll(CODEX_PLUGIN_SKILL_PATH_RE)) {
    if (match.index > 0 && /[A-Za-z0-9_$}]/.test(text[match.index - 1])) continue;
    const key = `${match.groups.name}:${match.groups.path}`;
    if (seenPathRefs.has(key)) continue;
    seenPathRefs.add(key);
    if (
      addSkillIdentityEvidence(
        skills,
        roots,
        match.groups.path,
        match.groups.name,
        {
          ts: context.ts,
          kind: context.kind,
          source: context.source,
          sourceFile: context.sourceFile,
          sourceLine: context.sourceLine,
          chatTitle: context.chatTitle,
        },
        usageEvent,
      )
    ) {
      count += 1;
    }
  }

  for (const match of text.matchAll(RELATIVE_DOT_SKILL_PATH_RE)) {
    if (match.index > 0 && !/\s|["'`({[<]/.test(text[match.index - 1])) continue;
    const name = context.aliases?.get(match.groups.name) || match.groups.name;
    const key = `${name}:${match.groups.path}`;
    if (seenPathRefs.has(key)) continue;
    seenPathRefs.add(key);
    if (
      addPathEvidence(
        skills,
        roots,
        match.groups.path,
        name,
        {
          ts: context.ts,
          kind: context.kind,
          source: context.source,
          sourceFile: context.sourceFile,
          sourceLine: context.sourceLine,
          chatTitle: context.chatTitle,
        },
        usageEvent,
      )
    ) {
      count += 1;
    }
  }

  for (const match of text.matchAll(BARE_SKILL_PATH_RE)) {
    const name = context.aliases?.get(match.groups.name) || match.groups.name;
    if ([...seenPathRefs].some((key) => key.startsWith(`${name}:`))) continue;
    const key = `${name}:${match[0]}`;
    if (seenPathRefs.has(key)) continue;
    seenPathRefs.add(key);
    if (
      addEvidence(
        skills,
        name,
        {
          ts: context.ts,
          kind: context.kind,
          source: context.source,
          sourceFile: context.sourceFile,
          sourceLine: context.sourceLine,
          chatTitle: context.chatTitle,
        },
        usageEvent,
      )
    ) {
      count += 1;
    }
  }

  for (const customPathRe of customPathRes) {
    for (const match of text.matchAll(customPathRe)) {
      if ([...seenPathRefs].some((key) => key.startsWith(`${match.groups.name}:`))) continue;
      const key = `${match.groups.name}:${match.groups.path}`;
      if (seenPathRefs.has(key)) continue;
      seenPathRefs.add(key);
      if (
        addPathEvidence(
          skills,
          roots,
          match.groups.path,
          match.groups.name,
          {
            ts: context.ts,
            kind: context.kind,
            source: context.source,
            sourceFile: context.sourceFile,
            sourceLine: context.sourceLine,
            chatTitle: context.chatTitle,
          },
          usageEvent,
        )
      ) {
        count += 1;
      }
    }
  }

  if (context.stats) context.stats.evidence += count;
  return count;
}

function addSkillNameEvidence(skills, rawName, context) {
  const name = context.aliases?.get(rawName) || rawName;
  if (
    addEvidence(
      skills,
      name,
      {
        ts: context.ts,
        kind: context.kind,
        source: context.source,
        sourceFile: context.sourceFile,
        sourceLine: context.sourceLine,
        chatTitle: context.chatTitle,
      },
      true,
    )
  ) {
    if (context.stats) context.stats.evidence += 1;
    return 1;
  }
  return 0;
}

function addStructuredSkillToolEvidence(skills, record, context) {
  let count = 0;
  for (const toolCall of structuredSkillToolCalls(record)) {
    for (const input of structuredToolInput(toolCall)) {
      if (!input || typeof input !== "object") continue;
      if (typeof input.skill === "string") {
        count += addSkillNameEvidence(skills, input.skill, context);
      }
    }
  }
  return count;
}

function addInvokedSkillsEvidence(skills, options, value, context) {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) => count + addInvokedSkillsEvidence(skills, options, item, context),
      0,
    );
  }
  if (!value || typeof value !== "object") return 0;

  let count = 0;
  if (value.type === "invoked_skills") {
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) {
        for (const skill of item) {
          if (!skill || typeof skill !== "object") continue;
          if (typeof skill.path === "string") {
            const matched = addSkillIdentityEvidence(
              skills,
              options.skillsDirs || options.skillsDir,
              skill.path,
              typeof skill.name === "string" ? skill.name : "",
              {
                ts: context.ts,
                kind: context.kind,
                source: context.source,
                sourceFile: context.sourceFile,
                sourceLine: context.sourceLine,
                chatTitle: context.chatTitle,
              },
              true,
            );
            if (matched) {
              if (context.stats) context.stats.evidence += 1;
              count += 1;
            }
            continue;
          }
          if (typeof skill.name === "string") {
            count += addSkillNameEvidence(skills, skill.name, context);
          }
        }
      }
    }
  }

  for (const item of Object.values(value)) {
    count += addInvokedSkillsEvidence(skills, options, item, context);
  }
  return count;
}

function addStructuredToolReadEvidence(skills, options, record, context) {
  let count = 0;
  for (const toolCall of structuredReadToolCalls(record)) {
    count += addSkillPathReferences(
      skills,
      options,
      jsonStrings(structuredToolInput(toolCall)).join("\n"),
      {
        ...context,
        usageEvent: true,
      },
    );
  }
  return count;
}

function addCommandNameSkillEvidence(skills, text, context) {
  let count = 0;
  for (const match of text.matchAll(COMMAND_NAME_RE)) {
    const name = match[1]?.trim();
    if (!name) continue;
    count += addSkillNameEvidence(skills, name, context);
  }
  return count;
}

function addReadCommandSkillEvidence(skills, options, text, context) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!READ_COMMAND_RE.test(line)) continue;
    count += addSkillPathReferences(skills, options, line, {
      ...context,
      usageEvent: true,
    });
  }
  return count;
}

function addScriptCommandSkillEvidence(skills, text, context) {
  let count = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("/scripts/")) continue;
    let matchedBareScript = false;
    for (const match of line.matchAll(BARE_SKILL_SCRIPT_RE)) {
      if (
        addEvidence(
          skills,
          match.groups.name,
          {
            ts: context.ts,
            kind: context.kind,
            source: context.source,
            sourceFile: context.sourceFile,
            sourceLine: context.sourceLine,
            chatTitle: context.chatTitle,
          },
          true,
        )
      ) {
        if (context.stats) context.stats.evidence += 1;
        count += 1;
        matchedBareScript = true;
      }
    }
    if (matchedBareScript) continue;
    for (const usage of skills.values()) {
      const skillDir = path.dirname(usage.path);
      const variants = [
        path.join(skillDir, "scripts") + path.sep,
        usage.realPath
          ? path.join(path.dirname(usage.realPath), "scripts") + path.sep
          : "",
      ].filter(Boolean);
      if (!variants.some((variant) => line.includes(variant))) continue;
      usage.usageEvents.push({
        ts: context.ts,
        kind: context.kind,
        source: context.source,
        sourceFile: context.sourceFile,
        sourceLine: context.sourceLine,
        chatTitle: context.chatTitle,
      });
      if (context.stats) context.stats.evidence += 1;
      count += 1;
    }
  }
  return count;
}

function claudeConfigFiles(claudeDir) {
  const parent = path.dirname(claudeDir);
  return existingRoots([
    path.join(parent, ".claude.json"),
    path.join(claudeDir, "config.json"),
  ]);
}

function scanClaudeSkillUsageConfig(skills, options, stats, aliases) {
  for (const file of claudeConfigFiles(options.claudeDir)) {
    const parsed = readJsonFile(file);
    const skillUsage = parsed?.skillUsage;
    if (!skillUsage || typeof skillUsage !== "object") continue;

    for (const [rawName, usage] of Object.entries(skillUsage)) {
      if (!usage || typeof usage !== "object") continue;
      const ts = timestampFromRecord({
        lastUsedAt: usage.lastUsedAt,
        updatedAt: usage.lastUsedAt,
      });
      if (!ts) continue;
      addSkillNameEvidence(skills, rawName, {
        ts,
        kind: "claude_skill_usage_config",
        source: sourcePointer(file, null),
        sourceFile: file,
        sourceLine: null,
        chatTitle: fileTitle(file),
        aliases,
        stats,
      });
    }
  }
}

function processMatchedJsonLine(item, stats, onRecord) {
  stats.matchedLines += 1;
  let record;
  try {
    record = JSON.parse(item.line);
  } catch {
    stats.parseErrors += 1;
    return;
  }
  stats.parsedRecords += 1;
  onRecord(record, item.file, item.lineNo, item.line);
}

function fixedPatternFile(patterns) {
  const file = path.join(process.env.TMPDIR || "/tmp", `skillkill-rg-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(file, `${patterns.join("\n")}\n`);
  return file;
}

function jsonlRootsSize(roots) {
  let size = 0;
  for (const root of roots) {
    for (const file of walkFiles(root, (item) => item.endsWith(".jsonl"))) {
      try {
        size += fs.statSync(file).size;
      } catch {
      }
    }
  }
  return size;
}

async function readSelectedJsonLines(file, lineNumbers) {
  const selected = new Set(lineNumbers);
  const rows = [];
  let lineNo = 0;
  if (!fs.existsSync(file)) return rows;

  const input = fs.createReadStream(file, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      lineNo += 1;
      if (!selected.has(lineNo)) continue;
      rows.push({ file, lineNo, line });
      if (rows.length === selected.size) break;
    }
  } finally {
    rl.close();
    input.destroy();
  }
  return rows;
}

async function scanRgJsonLines(roots, pattern, stats, onRecord, shouldProcessRaw = () => true) {
  if (roots.length === 0) return true;
  const pipelinePattern = pattern && typeof pattern === "object" && !Array.isArray(pattern);
  const usePipeline = pipelinePattern && jsonlRootsSize(roots) > 50 * 1024 * 1024;
  const patternFile = Array.isArray(pattern)
    ? fixedPatternFile(pattern)
    : usePipeline
      ? fixedPatternFile(pattern.fixed)
      : "";
  const child = usePipeline
    ? spawn(
        "sh",
        [
          "-c",
          [
            "rg -n --no-heading --color never --no-messages --glob '*.jsonl'",
            "-e",
            shellQuote(pattern.prefilter),
            ...roots.map(shellQuote),
            "|",
            "rg -F",
            shellQuote('"type":"response_item"'),
            "|",
            "rg -v -e",
            shellQuote('"type":"(?:custom_tool_call_output|function_call_output)"|"role":"developer"'),
            "|",
            "rg -F -f",
            shellQuote(patternFile),
          ].join(" "),
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      )
    : spawn(
        "rg",
        [
          "-n",
          "--no-heading",
          "--color",
          "never",
          "--no-messages",
          "--glob",
          "*.jsonl",
          ...(Array.isArray(pattern)
            ? ["-F", "-f", patternFile]
            : ["-e", pipelinePattern ? pattern.prefilter : pattern]),
          ...roots,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
  const status = new Promise((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", (code) => resolve(code));
  });

  const seen = new Set();
  const matchedFiles = new Set();
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

  try {
    for await (const raw of rl) {
      if (!raw.trim()) continue;
      const match = raw.match(/^([^:]+):(\d+):(.*)$/);
      if (!match) continue;
      const file = match[1];
      const lineNo = Number(match[2]);
      const line = match[3];
      if (!file || Number.isNaN(lineNo)) continue;
      if (!shouldProcessRaw(line)) continue;
      const key = `${file}:${lineNo}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matchedFiles.add(file);
      processMatchedJsonLine({ file, lineNo, line }, stats, onRecord);
    }
  } finally {
    rl.close();
  }

  const exitStatus = await status;
  if (patternFile) {
    try {
      fs.unlinkSync(patternFile);
    } catch {
    }
  }
  if (![0, 1].includes(exitStatus)) return false;

  stats.matchedFiles += matchedFiles.size;
  addStrategy(stats, "ripgrep-line-prefilter");
  return true;
}

function readJsonLines(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((line, index) => ({ file, lineNo: index + 1, line }))
      .filter(({ line }) => line.trim().length > 0);
  } catch {
    return [];
  }
}

async function scanJsonLines(files, stats, shouldReadLine, onRecord) {
  const matchedFiles = new Set();

  for (const file of files) {
    let lineNo = 0;
    let input;
    try {
      input = fs.createReadStream(file, { encoding: "utf8" });
    } catch {
      continue;
    }
    const rl = readline.createInterface({ input, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        lineNo += 1;
        if (!line.trim() || !shouldReadLine(line)) continue;

        matchedFiles.add(file);
        stats.matchedLines += 1;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          stats.parseErrors += 1;
          continue;
        }
        stats.parsedRecords += 1;
        onRecord(record, file, lineNo);
      }
    } finally {
      rl.close();
      input.destroy();
    }
  }

  stats.matchedFiles += matchedFiles.size;
}

async function scanMatchingJsonLines(
  roots,
  pattern,
  stats,
  onRecord,
  fullScan = false,
  shouldProcessRaw = () => true,
) {
  if (roots.length === 0) return;
  const started = Date.now();
  const allFiles = () =>
    roots.flatMap((root) => walkFiles(root, (file) => file.endsWith(".jsonl")));
  if (!fullScan && (await scanRgJsonLines(roots, pattern, stats, onRecord, shouldProcessRaw))) {
    stats.elapsedMs += Date.now() - started;
    return;
  }

  {
    const pipelinePattern = pattern && typeof pattern === "object" && !Array.isArray(pattern);
    const prefilter = Array.isArray(pattern) || pipelinePattern ? null : new RegExp(pattern);
    const fixedPatterns = Array.isArray(pattern) ? pattern : pattern.fixed;
    await scanJsonLines(
      allFiles(),
      stats,
      (line) =>
        (fullScan || (prefilter ? prefilter.test(line) : fixedPatterns.some((item) => line.includes(item)))) &&
        shouldProcessRaw(line),
      onRecord,
    );
    addStrategy(stats, fullScan ? "full-jsonl-scan" : "full-jsonl-fallback");
    stats.elapsedMs += Date.now() - started;
    return;
  }
}

function rgMatchingFiles(roots, pattern, glob) {
  if (roots.length === 0) return null;
  const args = [
    "-l",
    "--no-heading",
    "--color",
    "never",
    "--no-messages",
    "--glob",
    glob,
    "-e",
    pattern,
    ...roots,
  ];
  const result = spawnSync("rg", args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error) return null;
  if (![0, 1].includes(result.status)) return null;
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function scanMatchingJsonFiles(roots, pattern, stats, onRecord, fullScan = false) {
  if (roots.length === 0) return;
  const started = Date.now();
  const allFiles = () =>
    roots.flatMap((root) => walkFiles(root, (file) => file.endsWith(".json")));

  let files;
  if (fullScan) {
    files = allFiles();
    addStrategy(stats, "full-json-scan");
  } else {
    files = rgMatchingFiles(roots, pattern, "*.json");
    if (files === null) {
      const prefilter = new RegExp(pattern);
      files = allFiles().filter((file) => {
        try {
          return prefilter.test(fs.readFileSync(file, "utf8"));
        } catch {
          return false;
        }
      });
      addStrategy(stats, "full-json-fallback");
    } else {
      addStrategy(stats, "ripgrep-file-prefilter");
    }
  }

  stats.matchedFiles += new Set(files).size;
  stats.matchedLines += files.length;
  for (const file of files) {
    const parsed = readJsonFile(file);
    if (parsed === undefined) {
      stats.parseErrors += 1;
      continue;
    }
    const records = Array.isArray(parsed) ? parsed : [parsed];
    for (const record of records) {
      stats.parsedRecords += 1;
      onRecord(record, file, null);
    }
  }
  stats.elapsedMs += Date.now() - started;
}

function rgPathMatches(roots, pattern, options = {}) {
  if (roots.length === 0) return null;
  const args = [
    "-n",
    "-o",
    "--no-heading",
    "--color",
    "never",
    "--no-messages",
  ];
  if (options.binary) args.push("-a");
  if (options.glob) args.push("--glob", options.glob);
  for (const excludeGlob of options.excludeGlobs || []) {
    args.push("--glob", `!${excludeGlob}`);
  }
  args.push("-e", pattern, ...roots);

  const result = spawnSync("rg", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) return null;
  if (![0, 1].includes(result.status)) return null;
  return result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function fileMatchesGlob(file, glob) {
  if (!glob) return true;
  if (glob.startsWith("**/")) return path.basename(file) === glob.slice(3);
  return path.basename(file) === glob;
}

function fallbackPathMatches(skills, roots, pattern, stats, options, kind, scanOptions) {
  const re = new RegExp(pattern, "g");
  const files = roots.flatMap((root) =>
    walkFiles(root, (file) =>
      fileMatchesGlob(file, scanOptions.glob) &&
      !(scanOptions.excludeGlobs || []).some((glob) => fileMatchesGlob(file, glob)),
    ),
  );
  const matchedFiles = new Set();

  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "latin1");
    } catch {
      continue;
    }

    for (const match of text.matchAll(re)) {
      matchedFiles.add(file);
      stats.matchedLines += 1;
      stats.parsedRecords += 1;
      addSkillPathReferences(skills, options, match[0], {
        ts: fileTimestamp(file),
        kind,
        source: sourcePointer(file, null),
        stats,
      });
    }
  }
  stats.matchedFiles += matchedFiles.size;
}

function scanPathMatchesInRoots(skills, roots, pattern, stats, options, kind, scanOptions = {}) {
  if (roots.length === 0) return;
  const started = Date.now();
  const rows = rgPathMatches(roots, pattern, scanOptions);
  if (rows === null) {
    addStrategy(stats, "full-path-fallback");
    fallbackPathMatches(skills, roots, pattern, stats, options, kind, scanOptions);
    stats.elapsedMs += Date.now() - started;
    return;
  }

  addStrategy(stats, "ripgrep-path-prefilter");
  const matchedFiles = new Set();
  for (const row of rows) {
    const match = row.match(/^(.*):(\d+):(.*)$/);
    if (!match) continue;
    const file = match[1];
    const lineNo = Number(match[2]);
    const pathText = match[3];
    matchedFiles.add(file);
    stats.matchedLines += 1;
    stats.parsedRecords += 1;
    addSkillPathReferences(skills, options, pathText, {
      ts: fileTimestamp(file),
      kind,
      source: sourcePointer(file, Number.isNaN(lineNo) ? null : lineNo),
      stats,
    });
  }
  stats.matchedFiles += matchedFiles.size;
  stats.elapsedMs += Date.now() - started;
}

function sqliteJsonRows(db, query) {
  const result = spawnSync("sqlite3", ["-json", db, query], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) return null;
  try {
    return JSON.parse(result.stdout || "[]");
  } catch {
    return null;
  }
}

function sqliteAvailable() {
  const result = spawnSync("sqlite3", ["--version"], { encoding: "utf8" });
  return !result.error && result.status === 0;
}

function scanCursorStoreDbs(skills, roots, stats, options) {
  if (roots.length === 0) return false;
  if (!sqliteAvailable()) return false;

  const started = Date.now();
  const files = roots.flatMap((root) => walkFiles(root, (file) => path.basename(file) === "store.db"));
  const matchedFiles = new Set();

  for (const file of files) {
    const rows = sqliteJsonRows(
      file,
      "select id, cast(data as text) as text from blobs where cast(data as text) like '%SKILL.md%'",
    );
    if (!rows) {
      continue;
    }

    for (const row of rows) {
      if (typeof row.text !== "string") continue;
      matchedFiles.add(file);
      stats.matchedLines += 1;
      stats.parsedRecords += 1;
      addSkillPathReferences(skills, options, row.text, {
        ts: fileTimestamp(file),
        kind: "cursor_sqlite_path_reference",
        source: `${sourceLabel(file)}:${row.id || "blob"}`,
        sourceFile: file,
        sourceLine: null,
        chatTitle: fileTitle(file),
        stats,
      });
    }
  }

  if (matchedFiles.size > 0) {
    stats.matchedFiles += matchedFiles.size;
    addStrategy(stats, "sqlite-blob-scan");
  }
  stats.elapsedMs += Date.now() - started;
  return true;
}

function cursorHome(cursorDir) {
  return path.basename(cursorDir) === "chats" ? path.dirname(cursorDir) : cursorDir;
}

async function scanCodex(skills, options, stats) {
  const rootsForSkills = options.skillsDirs || options.skillsDir;
  const roots = existingRoots([
    path.join(options.codexDir, "archived_sessions"),
    path.join(options.codexDir, "sessions"),
  ]);
  addRecentChats(
    stats,
    "codex",
    countRecentFiles(roots, (file) => file.endsWith(".jsonl"), jsonlStartTimestamp, options),
  );
  const pattern = {
    prefilter: String.raw`SKILL\.md|/scripts/|<command-name>`,
    fixed: installedSkillFixedPatterns(skills),
  };
  const shouldProcessRaw = installedSkillRawMatcher(skills);

  await scanMatchingJsonLines(
    roots,
    pattern,
    stats.codex,
    (record, file, lineNo, rawLine) => {
      const ts = record ? timestampFromRecord(record) : fileTimestamp(file);
      const text = record ? jsonStrings(record).join("\n") : rawLine;
      const usageText = codexUsageText(record, rawLine);
      let usageEventCount = 0;

      for (const blockMatch of usageText.matchAll(SKILL_BLOCK_RE)) {
        const name = blockMatch[1]?.trim();
        const skillPath = blockMatch[2]?.trim();
        if (!name || !skillPath) continue;
        if (
          addSkillIdentityEvidence(
            skills,
            rootsForSkills,
            skillPath,
            name,
            {
              ts,
              kind: "codex_skill_block",
              source: `${sourceLabel(file)}:${lineNo}`,
              sourceFile: file,
              sourceLine: lineNo,
              chatTitle: chatTitle(record, file),
            },
            true,
        )
        ) {
          stats.codex.evidence += 1;
          usageEventCount += 1;
        }
      }

      usageEventCount += addReadCommandSkillEvidence(skills, options, usageText, {
        ts,
        kind: "codex_skill_read_command",
        source: sourcePointer(file, lineNo),
        sourceFile: file,
        sourceLine: lineNo,
        chatTitle: chatTitle(record, file),
        stats: stats.codex,
      });
      usageEventCount += addScriptCommandSkillEvidence(skills, usageText, {
        ts,
        kind: "codex_skill_script_command",
        source: sourcePointer(file, lineNo),
        sourceFile: file,
        sourceLine: lineNo,
        chatTitle: chatTitle(record, file),
        stats: stats.codex,
      });
      usageEventCount += addCommandNameSkillEvidence(skills, usageText, {
        ts,
        kind: "codex_command_name_skill",
        source: sourcePointer(file, lineNo),
        sourceFile: file,
        sourceLine: lineNo,
        chatTitle: chatTitle(record, file),
        stats: stats.codex,
      });

      if (usageEventCount === 0 && record) {
        addSkillPathReferences(skills, options, text, {
          ts,
          kind: "codex_path_reference",
          source: sourcePointer(file, lineNo),
          sourceFile: file,
          sourceLine: lineNo,
          chatTitle: chatTitle(record, file),
          stats: stats.codex,
        });
      }
    },
    options.fullScan,
    shouldProcessRaw,
  );
}

function claudeAliases(claudeDir, skillsDirs) {
  const aliases = new Map();
  const claudeSkills = path.join(claudeDir, "skills");
  if (!fs.existsSync(claudeSkills)) return aliases;

  for (const entry of fs.readdirSync(claudeSkills, { withFileTypes: true })) {
    const fullPath = path.join(claudeSkills, entry.name);
    let resolved;
    try {
      resolved = fs.realpathSync(fullPath);
    } catch {
      continue;
    }
    if (!skillDirs(skillsDirs).some((skillsDir) => withinRoot(resolved, skillsDir))) continue;
    const name = path.basename(
      resolved.endsWith("SKILL.md") ? path.dirname(resolved) : resolved,
    );
    aliases.set(entry.name, name);
  }
  return aliases;
}

async function scanClaude(skills, options, stats) {
  const rootsForSkills = options.skillsDirs || options.skillsDir;
  const aliases = claudeAliases(options.claudeDir, rootsForSkills);
  const jsonlRoots = existingRoots([
    path.join(options.claudeDir, "history.jsonl"),
    path.join(options.claudeDir, "projects"),
    path.join(options.claudeAppDir, "claude-code-sessions"),
    path.join(options.claudeAppDir, "local-agent-mode-sessions"),
  ]);
  const sessionRoots = existingRoots([
    path.join(options.claudeDir, "projects"),
    path.join(options.claudeDir, "tasks"),
    path.join(options.claudeDir, "sessions"),
    path.join(options.claudeAppDir, "claude-code-sessions"),
    path.join(options.claudeAppDir, "local-agent-mode-sessions"),
  ]);
  addRecentChats(
    stats,
    "claude",
    countRecentFiles(
      sessionRoots,
      (file) => file.endsWith(".jsonl") || file.endsWith(".json"),
      (file) => (file.endsWith(".jsonl") ? jsonlStartTimestamp(file) : jsonStartTimestamp(file)),
      options,
    ),
  );
  const pattern = [
    `"attributionSkill"`,
    `"invoked_skills"`,
    `"name"\\s*:\\s*"Skill"`,
    `<command-name>`,
    skillScriptSearchPattern(skills),
    installedSkillPathSearchPattern(skills),
  ].filter(Boolean).join("|");

  const onRecord = (record, file, lineNo, rawLine) => {
    const ts = record ? timestampFromRecord(record) || fileTimestamp(file) : fileTimestamp(file);
    let usageEventCount = 0;

    for (const attributionSkill of attributionSkills(record)) {
      const name = aliases.get(attributionSkill) || attributionSkill;
      if (
        addEvidence(
          skills,
          name,
          {
            ts,
            kind: "claude_attribution_skill",
            source: sourcePointer(file, lineNo),
            sourceFile: file,
            sourceLine: lineNo,
            chatTitle: chatTitle(record, file),
          },
          true,
        )
      ) {
        stats.claude.evidence += 1;
        usageEventCount += 1;
      }
    }

    const text = record ? jsonStrings(record).join("\n") : rawLine;
    const usageText = claudeUsageText(record, rawLine);
    usageEventCount += record ? addStructuredSkillToolEvidence(skills, record, {
      ts,
      kind: "claude_skill_tool",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      aliases,
      stats: stats.claude,
    }) : 0;
    usageEventCount += record ? addInvokedSkillsEvidence(skills, options, record, {
      ts,
      kind: "claude_invoked_skills_attachment",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      aliases,
      stats: stats.claude,
    }) : 0;
    usageEventCount += addCommandNameSkillEvidence(skills, usageText, {
      ts,
      kind: "claude_command_name_skill",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      aliases,
      stats: stats.claude,
    });
    usageEventCount += record ? addStructuredToolReadEvidence(skills, options, record, {
      ts,
      kind: "claude_tool_read_skill",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      aliases,
      stats: stats.claude,
    }) : 0;
    usageEventCount += addReadCommandSkillEvidence(skills, options, usageText, {
      ts,
      kind: "claude_skill_read_command",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      aliases,
      stats: stats.claude,
    });
    usageEventCount += addScriptCommandSkillEvidence(skills, usageText, {
      ts,
      kind: "claude_skill_script_command",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      stats: stats.claude,
    });

    if (usageEventCount === 0 && record) {
      addSkillPathReferences(skills, options, text, {
        ts,
        kind: "claude_path_reference",
        source: sourcePointer(file, lineNo),
        sourceFile: file,
        sourceLine: lineNo,
        chatTitle: chatTitle(record, file),
        aliases,
        stats: stats.claude,
      });
    }
  };

  await scanMatchingJsonLines(
    jsonlRoots,
    pattern,
    stats.claude,
    onRecord,
    options.fullScan,
  );

  await scanMatchingJsonFiles(
    existingRoots([
      path.join(options.claudeDir, "tasks"),
      path.join(options.claudeDir, "sessions"),
      path.join(options.claudeAppDir, "claude-code-sessions"),
      path.join(options.claudeAppDir, "local-agent-mode-sessions"),
    ]),
    pattern,
    stats.claude,
    onRecord,
    options.fullScan,
  );

  scanClaudeSkillUsageConfig(skills, options, stats.claude, aliases);
}

async function scanOpencode(skills, options, stats) {
  const rootsForSkills = options.skillsDirs || options.skillsDir;
  const roots = existingRoots([
    path.join(options.opencodeDir, "storage", "message"),
    path.join(options.opencodeDir, "storage", "part"),
    path.join(options.opencodeDir, "storage", "session", "message"),
    path.join(options.opencodeDir, "storage", "session", "part"),
  ]);
  addRecentChats(
    stats,
    "opencode",
    countRecentChildDirs(
      [
        path.join(options.opencodeDir, "storage", "message"),
      ],
      options,
    ),
  );
  const pattern = installedSkillPathSearchPattern(skills);

  await scanMatchingJsonFiles(
    roots,
    pattern,
    stats.opencode,
    (record, file) => {
      const ts = timestampFromRecord(record) || fileTimestamp(file);
      addStructuredToolReadEvidence(skills, options, record, {
        ts,
        kind: "opencode_tool_read_skill",
        source: sourcePointer(file, null),
        sourceFile: file,
        sourceLine: null,
        chatTitle: chatTitle(record, file),
        stats: stats.opencode,
      });
      addSkillPathReferences(skills, options, jsonStrings(record).join("\n"), {
        ts,
        kind: "opencode_path_reference",
        source: sourcePointer(file, null),
        sourceFile: file,
        sourceLine: null,
        chatTitle: chatTitle(record, file),
        stats: stats.opencode,
      });
    },
    options.fullScan,
  );
}

async function scanCursor(skills, options, stats) {
  const rootsForSkills = options.skillsDirs || options.skillsDir;
  const roots = existingRoots([options.cursorDir]);
  const home = cursorHome(options.cursorDir);
  addRecentChats(stats, "cursor", countRecentChildDirs([options.cursorDir], options));

  await scanMatchingJsonLines(
    existingRoots([path.join(home, "projects")]),
    installedSkillPathSearchPattern(skills),
    stats.cursor,
    (record, file, lineNo, rawLine) => {
      const ts = record ? timestampFromRecord(record) || fileTimestamp(file) : fileTimestamp(file);
      let usageEventCount = 0;
      usageEventCount += record ? addStructuredToolReadEvidence(skills, options, record, {
        ts,
        kind: "cursor_agent_transcript_tool_read_skill",
        source: sourcePointer(file, lineNo),
        sourceFile: file,
        sourceLine: lineNo,
        chatTitle: chatTitle(record, file),
        stats: stats.cursor,
      }) : 0;

      if (usageEventCount === 0 && record) {
        addSkillPathReferences(skills, options, record ? jsonStrings(record).join("\n") : rawLine, {
          ts,
          kind: "cursor_agent_transcript_path_reference",
          source: sourcePointer(file, lineNo),
          sourceFile: file,
          sourceLine: lineNo,
          chatTitle: chatTitle(record, file),
          stats: stats.cursor,
        });
      }
    },
    options.fullScan,
  );

  const sqliteAvailable = scanCursorStoreDbs(skills, roots, stats.cursor, options);
  if (sqliteAvailable) return;

  scanPathMatchesInRoots(
    skills,
    roots,
    installedSkillPathSearchPattern(skills),
    stats.cursor,
    options,
    "cursor_path_reference",
    { binary: true, glob: "**/store.db" },
  );
}

async function scanFilesystem(skills, options, stats) {
  const rootsForSkills = options.skillsDirs || options.skillsDir;
  const roots = existingRoots(options.evidenceDirs || []);
  const onRecord = (record, file, lineNo) => {
    const ts = timestampFromRecord(record) || fileTimestamp(file);
    let usageEventCount = 0;
    usageEventCount += addStructuredToolReadEvidence(skills, options, record, {
      ts,
      kind: "filesystem_tool_read_skill",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      stats: stats.filesystem,
    });
    const text = jsonStrings(record).join("\n");
    usageEventCount += addReadCommandSkillEvidence(skills, options, text, {
      ts,
      kind: "filesystem_skill_read_command",
      source: sourcePointer(file, lineNo),
      sourceFile: file,
      sourceLine: lineNo,
      chatTitle: chatTitle(record, file),
      stats: stats.filesystem,
    });
    if (usageEventCount === 0) {
      addSkillPathReferences(skills, options, text, {
        ts,
        kind: "filesystem_path_reference",
        source: sourcePointer(file, lineNo),
        sourceFile: file,
        sourceLine: lineNo,
        chatTitle: chatTitle(record, file),
        stats: stats.filesystem,
      });
    }
  };

  await scanMatchingJsonLines(
    roots,
    "SKILL\\.md",
    stats.filesystem,
    onRecord,
    options.fullScan,
  );
  await scanMatchingJsonFiles(
    roots,
    "SKILL\\.md",
    stats.filesystem,
    onRecord,
    options.fullScan,
  );
  scanPathMatchesInRoots(
    skills,
    roots,
    skillPathSearchPattern(rootsForSkills),
    stats.filesystem,
    options,
    "filesystem_path_reference",
    { excludeGlobs: ["*.json", "*.jsonl"] },
  );
}

export function newStats() {
  const scan = () => ({
    strategy: "not-run",
    elapsedMs: 0,
    matchedLines: 0,
    parsedRecords: 0,
    parseErrors: 0,
    evidence: 0,
    matchedFiles: 0,
    recentNewChats: 0,
  });
  return {
    elapsedMs: 0,
    recentNewChats: 0,
    codex: scan(),
    claude: scan(),
    opencode: scan(),
    cursor: scan(),
    filesystem: scan(),
  };
}

export async function scanEvidence(skills, options) {
  const stats = newStats();
  const started = Date.now();
  if (options.source === "codex" || options.source === "all") {
    await scanCodex(skills, options, stats);
  }
  if (options.source === "claude" || options.source === "all") {
    await scanClaude(skills, options, stats);
  }
  if (options.source === "opencode" || options.source === "all") {
    await scanOpencode(skills, options, stats);
  }
  if (options.source === "cursor" || options.source === "all") {
    await scanCursor(skills, options, stats);
  }
  if (options.source === "filesystem" || options.source === "all") {
    await scanFilesystem(skills, options, stats);
  }
  stats.elapsedMs = Date.now() - started;
  return stats;
}
