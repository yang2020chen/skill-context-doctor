import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./args.js";
import { formatNumber } from "./format.js";
import { renderLogo } from "./logo.js";
import { getVercelLockPaths } from "./vercel-lock.js";

function formatTokens(count) {
  const number = Number(count) || 0;
  if (number >= 1000) {
    const k = (number / 1000).toFixed(1);
    return `~${k}K`;
  }
  return `${number}`;
}

export function detectBrokenSkills(skillsDirs, options = {}) {
  const broken = [];
  const dirs = skillsDirs || options.skillsDirs || [];
  const registeredSkillNames = new Set();

  if (options.registeredSkills) {
    for (const item of options.registeredSkills) {
      registeredSkillNames.add(typeof item === "string" ? item : item.name || item.skill);
    }
  }

  const lockPaths = options.lockPaths
    ? (Array.isArray(options.lockPaths) ? options.lockPaths : [options.lockPaths])
    : options.noGlobalLock
      ? []
      : getVercelLockPaths({ skillsDirs: dirs, ...options });

  const lockEntries = [];
  for (const lockPath of lockPaths) {
    if (!lockPath || !fs.existsSync(lockPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, "utf8"));
      if (parsed && typeof parsed.skills === "object" && parsed.skills !== null) {
        for (const [name, entry] of Object.entries(parsed.skills)) {
          registeredSkillNames.add(name);
          const resolvedLock = path.resolve(lockPath);
          let targetSkillsDir = "";
          if (path.basename(resolvedLock) === ".skill-lock.json") {
            targetSkillsDir = path.join(path.dirname(resolvedLock), "skills");
          } else if (path.basename(resolvedLock) === "skills-lock.json") {
            targetSkillsDir = path.join(path.dirname(resolvedLock), ".agents", "skills");
          }
          lockEntries.push({ name, entry, targetSkillsDir });
        }
      }
    } catch {}
  }

  const seenPaths = new Set();

  for (const rawDir of dirs) {
    const dir = expandHome(rawDir);
    if (!fs.existsSync(dir)) continue;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const entryPath = path.join(dir, entry.name);
        const skillFile = path.join(entryPath, "SKILL.md");

        try {
          const lstat = fs.lstatSync(entryPath);

          // ① Dangling symlink: skill-link -> nonexistent target
          if (lstat.isSymbolicLink()) {
            if (!fs.existsSync(entryPath)) {
              broken.push({
                name: entry.name,
                path: entryPath,
                reason: "broken symlink target",
              });
              seenPaths.add(path.resolve(entryPath));
              continue;
            }
          }

          // ② Registered skill missing SKILL.md
          if (!fs.existsSync(skillFile)) {
            if (registeredSkillNames.has(entry.name)) {
              broken.push({
                name: entry.name,
                path: entryPath,
                reason: "missing SKILL.md",
              });
              seenPaths.add(path.resolve(entryPath));
            }
            // Regular directories without SKILL.md are ignored
            continue;
          }
        } catch (error) {
          if (registeredSkillNames.has(entry.name) || entry.isSymbolicLink()) {
            broken.push({
              name: entry.name,
              path: entryPath,
              reason: error?.message || String(error),
            });
            seenPaths.add(path.resolve(entryPath));
          }
        }
      }
    } catch {}
  }

  // Check if lockfile-registered skills are missing their directory completely
  for (const { name, targetSkillsDir } of lockEntries) {
    if (!targetSkillsDir) continue;
    const matchingDir = dirs.find(
      (d) => path.resolve(expandHome(d)) === path.resolve(targetSkillsDir),
    );
    if (matchingDir) {
      const expectedDir = path.join(targetSkillsDir, name);
      if (!seenPaths.has(path.resolve(expectedDir))) {
        const expectedSkillMd = path.join(expectedDir, "SKILL.md");
        if (!fs.existsSync(expectedSkillMd)) {
          broken.push({
            name,
            path: expectedDir,
            reason: fs.existsSync(expectedDir) ? "missing SKILL.md" : "missing skill directory",
          });
          seenPaths.add(path.resolve(expectedDir));
        }
      }
    }
  }

  return broken;
}

export function detectEvidenceSources(options = {}) {
  const detected = [];

  const piDir = expandHome(options.piDir || "~/.pi/agent");
  if (fs.existsSync(piDir)) detected.push("Pi");

  const claudeDir = expandHome(options.claudeDir || "~/.claude");
  const claudeAppDir = options.claudeAppDir ? expandHome(options.claudeAppDir) : "";
  if (fs.existsSync(claudeDir) || (claudeAppDir && fs.existsSync(claudeAppDir))) {
    detected.push("Claude Code");
  }

  const codexDir = expandHome(options.codexDir || "~/.codex");
  if (fs.existsSync(codexDir)) detected.push("Codex");

  const opencodeDir = expandHome(options.opencodeDir || "~/.local/share/opencode");
  if (fs.existsSync(opencodeDir)) detected.push("OpenCode");

  const cursorDir = expandHome(options.cursorDir || "~/.cursor/chats");
  const cursorRoot = expandHome("~/.cursor");
  if (fs.existsSync(cursorDir) || fs.existsSync(cursorRoot)) {
    detected.push("Cursor");
  }

  return detected;
}

export function buildAuditReport(skills, rows, options = {}) {
  const unusedDays = options.unusedDays ?? 45;
  const brokenList = detectBrokenSkills(options.skillsDirs || [], options);
  const brokenNames = new Set(brokenList.map((b) => b.name));
  const detectedSources = detectEvidenceSources(options);
  const skillFacts = [];

  // Group by unique skill name
  const skillsByName = new Map();
  for (const usage of skills.values()) {
    const list = skillsByName.get(usage.skill) || [];
    list.push(usage);
    skillsByName.set(usage.skill, list);
  }

  const uniqueSkills = skillsByName.size;
  const installations = skills.size;

  let duplicateGroups = 0;
  let duplicateCopies = 0;
  for (const list of skillsByName.values()) {
    if (list.length > 1) {
      duplicateGroups += 1;
      duplicateCopies += (list.length - 1);
    }
  }

  // Model-visible skills and context tokens
  // A unique skill is model-visible if it's not dot-prefixed and at least one install has !disableModelInvocation
  let modelVisibleCount = 0;
  let estimatedVisibleSkillTokens = 0;
  const visibleSkillsList = [];

  // Usage and stale tracking by unique skill
  let usedCount = 0;
  let staleCount = 0;

  // Source-level tracking
  const sourceStats = {
    pi: { usedSkills: 0, usageEvents: 0 },
    claude: { usedSkills: 0, usageEvents: 0 },
    codex: { usedSkills: 0, usageEvents: 0 },
    opencode: { usedSkills: 0, usageEvents: 0 },
    cursor: { usedSkills: 0, usageEvents: 0 },
    filesystem: { usedSkills: 0, usageEvents: 0 },
  };

  for (const [skillName, usages] of skillsByName.entries()) {
    const isDotPrefixed = skillName.startsWith(".");
    const primaryUsage = usages[0];
    const isModelVisible = !isDotPrefixed && usages.some((u) => !u.disableModelInvocation);

    // Context token cost: only for model-visible skills
    let tokenCost = 0;
    if (isModelVisible) {
      modelVisibleCount += 1;
      const desc = usages.find((u) => u.description)?.description || primaryUsage.description || "";
      tokenCost = desc.trim() ? Math.max(1, Math.ceil(desc.trim().length / 4)) : 0;
      estimatedVisibleSkillTokens += tokenCost;
    }

    // Aggregate usage events across all installs of this skill
    const totalUsageEvents = usages.reduce((acc, u) => acc + (u.usageEvents?.length || 0), 0);
    const allUsageDates = usages
      .flatMap((u) => (u.usageEvents || []).map((e) => e.ts).filter(Boolean))
      .sort((a, b) => b.getTime() - a.getTime());
    const lastUsedDate = allUsageDates[0] || null;

    if (totalUsageEvents > 0) {
      usedCount += 1;
      const now = options.now || new Date();
      const ageDays = lastUsedDate
        ? Math.max(0, Math.floor((now.getTime() - lastUsedDate.getTime()) / 86_400_000))
        : null;
      if (ageDays !== null && ageDays > unusedDays) {
        staleCount += 1;
      }
    }

    // Per-source counts
    const piEvents = usages.reduce(
      (acc, u) => acc + (u.usageEvents || []).filter((e) => e.kind?.startsWith("pi_")).length,
      0,
    );
    if (piEvents > 0) {
      sourceStats.pi.usedSkills += 1;
      sourceStats.pi.usageEvents += piEvents;
    }

    const claudeEvents = usages.reduce(
      (acc, u) => acc + (u.usageEvents || []).filter((e) => e.kind?.startsWith("claude_")).length,
      0,
    );
    if (claudeEvents > 0) {
      sourceStats.claude.usedSkills += 1;
      sourceStats.claude.usageEvents += claudeEvents;
    }

    const codexEvents = usages.reduce(
      (acc, u) => acc + (u.usageEvents || []).filter((e) => e.kind?.startsWith("codex_")).length,
      0,
    );
    if (codexEvents > 0) {
      sourceStats.codex.usedSkills += 1;
      sourceStats.codex.usageEvents += codexEvents;
    }

    const opencodeEvents = usages.reduce(
      (acc, u) => acc + (u.usageEvents || []).filter((e) => e.kind?.startsWith("opencode_")).length,
      0,
    );
    if (opencodeEvents > 0) {
      sourceStats.opencode.usedSkills += 1;
      sourceStats.opencode.usageEvents += opencodeEvents;
    }

    const cursorEvents = usages.reduce(
      (acc, u) => acc + (u.usageEvents || []).filter((e) => e.kind?.startsWith("cursor_")).length,
      0,
    );
    if (cursorEvents > 0) {
      sourceStats.cursor.usedSkills += 1;
      sourceStats.cursor.usageEvents += cursorEvents;
    }

    const filesystemEvents = usages.reduce(
      (acc, u) => acc + (u.usageEvents || []).filter((e) => e.kind?.startsWith("filesystem_")).length,
      0,
    );
    if (filesystemEvents > 0) {
      sourceStats.filesystem.usedSkills += 1;
      sourceStats.filesystem.usageEvents += filesystemEvents;
    }

    const isBroken = brokenNames.has(skillName);
    const isUsed = totalUsageEvents > 0;
    const now = options.now || new Date();
    const ageDays = lastUsedDate
      ? Math.max(0, Math.floor((now.getTime() - lastUsedDate.getTime()) / 86_400_000))
      : null;
    const isStale = isUsed && ageDays !== null && ageDays > unusedDays;
    const isRecent = isUsed && (ageDays === null || ageDays <= unusedDays);
    const isNeverUsed = !isUsed;

    const totalMentions = usages.reduce((acc, u) => acc + (u.mentions?.length || 0), 0);
    const protectMentionDays = options.protectMentionDays ?? options.unusedDays ?? 45;
    const recentMentions = usages.reduce(
      (acc, u) =>
        acc +
        (u.mentions || []).filter(
          (m) => m.ts && Math.floor((now.getTime() - m.ts.getTime()) / 86_400_000) <= protectMentionDays,
        ).length,
      0,
    );

    const agentSources = [];
    if (piEvents > 0) agentSources.push("pi");
    if (claudeEvents > 0) agentSources.push("claude");
    if (codexEvents > 0) agentSources.push("codex");
    if (opencodeEvents > 0) agentSources.push("opencode");
    if (cursorEvents > 0) agentSources.push("cursor");
    if (filesystemEvents > 0) agentSources.push("filesystem");

    skillFacts.push({
      skill: skillName,
      isBroken,
      isDotPrefixed,
      isModelVisible,
      visibleTokens: tokenCost,
      usageCount: totalUsageEvents,
      lastUsed: lastUsedDate,
      usageAgeDays: ageDays,
      isUsed,
      isStale,
      isRecent,
      isNeverUsed,
      mentionCount: totalMentions,
      recentMentionCount: recentMentions,
      hasRecentMention: recentMentions > 0,
      installCount: usages.length,
      isDuplicate: usages.length > 1,
      agentUsageSources: agentSources,
      isCrossAgent: agentSources.length > 1,
    });

    // Top consumers: only model-visible skills
    if (isModelVisible) {
      visibleSkillsList.push({
        skill: skillName,
        visibleTokens: tokenCost,
        usageCount: totalUsageEvents,
        lastUsed: lastUsedDate ? lastUsedDate.toISOString().replace("T", " ").slice(0, 16) : "-",
      });
    }
  }

  for (const b of brokenList) {
    if (!skillsByName.has(b.name)) {
      skillFacts.push({
        skill: b.name,
        isBroken: true,
        isDotPrefixed: b.name.startsWith("."),
        isModelVisible: false,
        visibleTokens: 0,
        usageCount: 0,
        lastUsed: null,
        usageAgeDays: null,
        isUsed: false,
        isStale: false,
        isRecent: false,
        isNeverUsed: true,
        mentionCount: 0,
        recentMentionCount: 0,
        hasRecentMention: false,
        installCount: 1,
        isDuplicate: false,
        agentUsageSources: [],
        isCrossAgent: false,
      });
    }
  }

  const neverUsedCount = Math.max(0, uniqueSkills - usedCount);

  // Sort top consumers by visibleTokens descending, then usageCount descending
  visibleSkillsList.sort((a, b) => {
    if (b.visibleTokens !== a.visibleTokens) {
      return b.visibleTokens - a.visibleTokens;
    }
    return b.usageCount - a.usageCount;
  });

  const topLimit = options.limit && options.limit !== 40 ? options.limit : 10;
  const topConsumers = visibleSkillsList.slice(0, topLimit);

  return {
    summary: {
      uniqueSkills,
      installations,
      modelVisible: modelVisibleCount,
      used: usedCount,
      stale: staleCount,
      neverUsed: neverUsedCount,
      duplicateGroups,
      duplicateCopies,
      broken: brokenList.length,
      estimatedVisibleSkillTokens,
    },
    sources: sourceStats,
    topConsumers,
    brokenDetails: brokenList,
    evidenceSources: detectedSources,
    skillFacts,
  };
}

export function formatAuditReport(report, options = {}) {
  const { summary, sources, topConsumers, evidenceSources = [] } = report;
  const unusedDays = options.unusedDays ?? 45;

  const lines = [
    renderLogo(),
    "",
  ];

  if (evidenceSources.length > 0) {
    lines.push(`Evidence sources detected: ${evidenceSources.join(", ")}`);
    lines.push("");
  }

  lines.push("Skills & Installation Health");
  lines.push(`  Skills discovered         ${formatNumber(summary.uniqueSkills)}`);
  lines.push(`  Installations             ${formatNumber(summary.installations)}`);
  lines.push(`  Model-visible             ${formatNumber(summary.modelVisible)}`);
  lines.push(`  Actually used             ${formatNumber(summary.used)}`);
  if (summary.stale > 0) {
    lines.push(`    ↳ Stale (idle >${unusedDays}d)      ${formatNumber(summary.stale)}`);
  }
  lines.push(`  Never used                ${formatNumber(summary.neverUsed)}`);
  lines.push(
    `  Duplicate groups          ${formatNumber(summary.duplicateGroups)} (${formatNumber(summary.duplicateCopies)} extra ${summary.duplicateCopies === 1 ? "copy" : "copies"})`,
  );
  lines.push(`  Broken installations      ${formatNumber(summary.broken)}`);
  lines.push("");

  lines.push("Estimated Context Overhead");
  lines.push(`  Visible skill metadata    ${formatTokens(summary.estimatedVisibleSkillTokens)} tokens (${formatNumber(summary.estimatedVisibleSkillTokens)} tokens)`);
  lines.push("");

  const sourceEntries = [
    { label: "Pi", data: sources.pi },
    { label: "Claude Code", data: sources.claude },
    { label: "Codex", data: sources.codex },
    { label: "OpenCode", data: sources.opencode },
    { label: "Cursor", data: sources.cursor },
    { label: "Filesystem", data: sources.filesystem },
  ].filter((item) => item.data && (item.data.usedSkills > 0 || item.data.usageEvents > 0));

  if (sourceEntries.length > 0) {
    lines.push("Usage Sources Breakdown");
    for (const { label, data } of sourceEntries) {
      const paddedLabel = label.padEnd(16);
      lines.push(
        `  ${paddedLabel}  ${formatNumber(data.usedSkills)} ${data.usedSkills === 1 ? "skill" : "skills"} (${formatNumber(data.usageEvents)} ${data.usageEvents === 1 ? "event" : "events"})`,
      );
    }
    lines.push("");
  }

  if (topConsumers.length > 0) {
    lines.push("Top Context Consumers (Model-Visible)");
    lines.push("");
    lines.push("Skill                            Visible Tokens    Usage   Last Used       ");
    lines.push("------------------------------   --------------   ------   ----------------");
    for (const item of topConsumers) {
      const name = item.skill.length > 30 ? `${item.skill.slice(0, 27)}...` : item.skill.padEnd(30);
      const tokens = String(formatNumber(item.visibleTokens)).padStart(14);
      const usage = String(formatNumber(item.usageCount)).padStart(8);
      const lastUsed = String(item.lastUsed).padEnd(16);
      lines.push(`${name}   ${tokens}   ${usage}   ${lastUsed}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
