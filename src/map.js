import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./args.js";
import { formatNumber } from "./format.js";

export const STANDARD_AGENTS = [
  { key: "claude", label: "Claude", header: "Claude" },
  { key: "codex", label: "Codex", header: "Codex" },
  { key: "cursor", label: "Cursor", header: "Cursor" },
  { key: "pi", label: "Pi", header: "Pi" },
  { key: "opencode", label: "OpenCode", header: "OpenCode" },
];

export function classifyRoot(rootPath) {
  if (!rootPath) return "unknown";
  const normalized = path.resolve(expandHome(rootPath)).toLowerCase();
  if (
    normalized.endsWith(`${path.sep}.agents${path.sep}skills`) ||
    normalized.includes(`${path.sep}.agents${path.sep}`)
  ) {
    return "shared";
  }
  if (
    normalized.endsWith(`${path.sep}.claude${path.sep}skills`) ||
    normalized.includes(`${path.sep}.claude${path.sep}`)
  ) {
    return "claude";
  }
  if (
    normalized.endsWith(`${path.sep}.codex${path.sep}skills`) ||
    normalized.includes(`${path.sep}.codex${path.sep}`)
  ) {
    return "codex";
  }
  if (
    normalized.endsWith(`${path.sep}.cursor${path.sep}skills`) ||
    normalized.includes(`${path.sep}.cursor${path.sep}`)
  ) {
    return "cursor";
  }
  if (
    normalized.endsWith(`${path.sep}.pi${path.sep}agent${path.sep}skills`) ||
    normalized.includes(`${path.sep}.pi${path.sep}`)
  ) {
    return "pi";
  }
  if (normalized.includes("opencode")) {
    return "opencode";
  }
  return "custom";
}

function computeFileSha256(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const buffer = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(buffer).digest("hex");
  } catch {
    return null;
  }
}

function resolveAgentFromEvidence(evidence) {
  const kind = String(evidence?.kind || "").toLowerCase();
  const source = String(evidence?.source || "").toLowerCase();
  if (kind.startsWith("pi_") || source.includes(".pi")) return "pi";
  if (kind.startsWith("claude_") || source.includes("claude")) return "claude";
  if (kind.startsWith("codex_") || source.includes("codex")) return "codex";
  if (kind.startsWith("cursor_") || source.includes("cursor")) return "cursor";
  if (kind.startsWith("opencode_") || source.includes("opencode")) return "opencode";
  return "other";
}

export function buildCrossAgentMap(skills, lockEntriesBySkill = new Map(), options = {}) {
  // Collect all unique skill names from 3 sources:
  // 1. Current installations
  // 2. Lockfile registered skills
  // 3. Historical usage skills
  const allSkillNames = new Set();

  for (const skillRecord of skills.values()) {
    if (skillRecord.skill) allSkillNames.add(skillRecord.skill);
  }

  for (const lockedSkill of lockEntriesBySkill.keys()) {
    if (lockedSkill) allSkillNames.add(lockedSkill);
  }

  if (skills.uninstalledUsage) {
    for (const uninstalledSkill of skills.uninstalledUsage.keys()) {
      if (uninstalledSkill) allSkillNames.add(uninstalledSkill);
    }
  }

  const skillItems = [];

  for (const skillName of [...allSkillNames].sort((a, b) => a.localeCompare(b))) {
    const instances = [...skills.values()].filter((s) => s.skill === skillName && !s.uninstalled);
    const lockEntries = lockEntriesBySkill.get(skillName) || [];

    // Ownership calculation
    let ownershipStatus = "UNTRACKED";
    if (lockEntries.length === 1) {
      ownershipStatus = "SINGLE_SOURCE";
    } else if (lockEntries.length > 1) {
      const distinctSources = new Set(lockEntries.map((e) => `${e.source}::${e.sourceUrl}`));
      ownershipStatus = distinctSources.size > 1 ? "MULTIPLE_SOURCES" : "SINGLE_SOURCE";
    }

    const ownership = lockEntries.map((e) => ({
      source: e.source,
      sourceUrl: e.sourceUrl,
      sourceType: e.sourceType,
      skillPath: e.skillPath,
      lockFile: e.lockFile,
      lockVersion: e.lockVersion,
      installedAt: e.installedAt,
      updatedAt: e.updatedAt,
    }));

    // Classify exposures
    let sharedStore = { type: "none" };
    const agentExposures = {
      claude: { type: "none" },
      codex: { type: "none" },
      cursor: { type: "none" },
      pi: { type: "none" },
      opencode: { type: "none" },
    };

    const physicalRealpaths = new Set();
    const definitionHashes = new Set();
    let symlinkCount = 0;
    let brokenSymlinkCount = 0;

    for (const inst of instances) {
      const category = classifyRoot(inst.installRoot);
      const skillDir = path.dirname(inst.path);

      let expType = "physical";
      let target = inst.realPath ? path.dirname(inst.realPath) : skillDir;
      let isBroken = false;

      if (inst.isSymlink) {
        symlinkCount += 1;
        if (!fs.existsSync(inst.path)) {
          expType = "broken_symlink";
          isBroken = true;
          brokenSymlinkCount += 1;
        } else {
          expType = "symlink";
        }
      } else {
        if (!fs.existsSync(inst.path)) {
          expType = "broken_installation";
          isBroken = true;
        } else {
          expType = "physical";
          const dirRealpath = fs.realpathSync(skillDir);
          physicalRealpaths.add(dirRealpath);

          const fileHash = computeFileSha256(inst.path);
          if (fileHash) definitionHashes.add(fileHash);
        }
      }

      const exposure = {
        type: expType,
        path: inst.path,
        target: expType === "symlink" ? (inst.linkTarget || target) : undefined,
        visible: isBroken ? false : !inst.disableModelInvocation,
        sha256: expType === "physical" ? computeFileSha256(inst.path) : undefined,
      };

      if (category === "shared") {
        sharedStore = exposure;
      } else if (agentExposures[category] !== undefined) {
        agentExposures[category] = exposure;
      }
    }

    const physicalCopies = physicalRealpaths.size;

    // Canonical Path & Status Resolution (Rule 2)
    let canonicalPath = null;
    let canonicalStatus = "MISSING";

    if (physicalCopies === 1) {
      canonicalPath = [...physicalRealpaths][0];
      canonicalStatus = "RESOLVED";
    } else if (physicalCopies > 1) {
      canonicalPath = null;
      canonicalStatus = "AMBIGUOUS";
    } else {
      canonicalPath = null;
      canonicalStatus = "MISSING";
    }

    // Usage aggregation
    const usage = {};
    const allUsageEvents = [
      ...instances.flatMap((i) => i.usageEvents || []),
      ...(skills.uninstalledUsage?.get(skillName)?.usageEvents || []),
    ];

    for (const ev of allUsageEvents) {
      const agent = resolveAgentFromEvidence(ev);
      if (!usage[agent]) {
        usage[agent] = { events: 0, lastUsed: null };
      }
      usage[agent].events += 1;
      const evTs = ev.ts instanceof Date ? ev.ts.toISOString() : (ev.ts || null);
      if (evTs && (!usage[agent].lastUsed || evTs > usage[agent].lastUsed)) {
        usage[agent].lastUsed = evTs;
      }
    }

    // Status deduction
    const statuses = [];
    const totalUsageCount = Object.values(usage).reduce((acc, u) => acc + u.events, 0);

    if (physicalCopies === 0 && symlinkCount === 0) {
      if (ownership.length > 0) {
        statuses.push("REGISTERED_BUT_MISSING");
      } else if (totalUsageCount > 0) {
        statuses.push("HISTORICAL_ONLY");
      }
    } else {
      if (brokenSymlinkCount > 0) {
        statuses.push("BROKEN_SYMLINK");
      }
      if (physicalCopies > 1) {
        if (definitionHashes.size > 1) {
          statuses.push("SKILL_DEFINITION_DRIFT");
        } else {
          statuses.push("PHYSICAL_DUPLICATE");
        }
      } else if (physicalCopies === 1 && symlinkCount > 0) {
        statuses.push("SHARED_BY_SYMLINK");
      } else if (physicalCopies === 1 && symlinkCount === 0) {
        statuses.push("SINGLE_INSTALLATION");
      }

      if (ownership.length === 0) {
        statuses.push("UNTRACKED_INSTALLATION");
      }
    }

    if (ownershipStatus === "MULTIPLE_SOURCES") {
      statuses.push("MULTIPLE_SOURCES");
    }

    if (statuses.length === 0) {
      statuses.push("UNKNOWN");
    }

    skillItems.push({
      skill: skillName,
      installation: {
        canonicalPath,
        canonicalStatus,
        physicalCopies,
        symlinks: symlinkCount,
        definitionHashes: [...definitionHashes],
      },
      ownership,
      ownershipStatus,
      sharedStore,
      agentExposures,
      usage,
      statuses,
    });
  }

  // Summary counts
  const summary = {
    totalSkills: skillItems.length,
    canonicalResolved: skillItems.filter((s) => s.installation.canonicalStatus === "RESOLVED").length,
    canonicalAmbiguous: skillItems.filter((s) => s.installation.canonicalStatus === "AMBIGUOUS").length,
    canonicalMissing: skillItems.filter((s) => s.installation.canonicalStatus === "MISSING").length,
    sharedBySymlink: skillItems.filter((s) => s.statuses.includes("SHARED_BY_SYMLINK")).length,
    physicalDuplicates: skillItems.filter((s) => s.statuses.includes("PHYSICAL_DUPLICATE")).length,
    definitionDrifts: skillItems.filter((s) => s.statuses.includes("SKILL_DEFINITION_DRIFT")).length,
    brokenSymlinks: skillItems.filter((s) => s.statuses.includes("BROKEN_SYMLINK")).length,
    registeredMissing: skillItems.filter((s) => s.statuses.includes("REGISTERED_BUT_MISSING")).length,
    historicalOnly: skillItems.filter((s) => s.statuses.includes("HISTORICAL_ONLY")).length,
  };

  return {
    summary,
    skills: skillItems,
  };
}

function symbolForExposure(exposure) {
  if (!exposure || exposure.type === "none") return "-";
  if (exposure.type === "physical") return "✓";
  if (exposure.type === "symlink") return "↳";
  if (exposure.type === "broken_symlink" || exposure.type === "broken_installation") return "!";
  return "-";
}

export function formatCrossAgentMatrix(mapReport, options = {}) {
  const lines = [];
  lines.push("Skill Context Doctor - Cross-Agent Skill Map (v0.4.0)");
  lines.push("");

  const s = mapReport.summary;
  lines.push(`Summary: ${formatNumber(s.totalSkills)} total skills mapped`);
  lines.push(
    `  ${formatNumber(s.sharedBySymlink)} shared via symlink  |  ` +
    `${formatNumber(s.physicalDuplicates)} physical duplicates  |  ` +
    `${formatNumber(s.definitionDrifts)} definition drifts  |  ` +
    `${formatNumber(s.brokenSymlinks)} broken symlinks`,
  );
  lines.push("");

  // Table header
  // Skill: 30, Shared: 6, Claude: 6, Codex: 5, Cursor: 6, Pi: 4, OpenCode: 8, Copies: 6, Status: 22
  const header =
    "Skill".padEnd(30) + " " +
    "Shared".padStart(6) + " " +
    "Claude".padStart(6) + " " +
    "Codex".padStart(5) + " " +
    "Cursor".padStart(6) + " " +
    "Pi".padStart(4) + " " +
    "OpenCode".padStart(8) + " " +
    "Copies".padStart(6) + "  " +
    "Status";

  const divider =
    "-".repeat(30) + " " +
    "-".repeat(6) + " " +
    "-".repeat(6) + " " +
    "-".repeat(5) + " " +
    "-".repeat(6) + " " +
    "-".repeat(4) + " " +
    "-".repeat(8) + " " +
    "-".repeat(6) + "  " +
    "-".repeat(22);

  lines.push(header);
  lines.push(divider);

  const skillsToRender = options.limit && options.limit > 0
    ? mapReport.skills.slice(0, options.limit)
    : mapReport.skills;

  for (const item of skillsToRender) {
    const name = item.skill.length > 29 ? `${item.skill.slice(0, 26)}...` : item.skill;
    const sharedSym = symbolForExposure(item.sharedStore);
    const claudeSym = symbolForExposure(item.agentExposures.claude);
    const codexSym = symbolForExposure(item.agentExposures.codex);
    const cursorSym = symbolForExposure(item.agentExposures.cursor);
    const piSym = symbolForExposure(item.agentExposures.pi);
    const opencodeSym = symbolForExposure(item.agentExposures.opencode);
    const copies = String(item.installation.physicalCopies);
    const primaryStatus = item.statuses[0] || "UNKNOWN";

    const row =
      name.padEnd(30) + " " +
      sharedSym.padStart(6) + " " +
      claudeSym.padStart(6) + " " +
      codexSym.padStart(5) + " " +
      cursorSym.padStart(6) + " " +
      piSym.padStart(4) + " " +
      opencodeSym.padStart(8) + " " +
      copies.padStart(6) + "  " +
      primaryStatus;

    lines.push(row);
  }

  lines.push("");
  lines.push("Legend: ✓ Physical directory  ↳ Symlink  ! Broken/Drift  - Not present");
  lines.push("Run `skill-context-doctor map <skill-name>` for detailed topology and ownership.");

  return `${lines.join("\n")}\n`;
}

export function formatSkillDetailMap(item) {
  const lines = [];
  lines.push(`Skill: ${item.skill}`);
  lines.push("");

  lines.push("Canonical Installation");
  if (item.installation.canonicalPath) {
    lines.push(`  ${item.installation.canonicalPath}`);
    lines.push(`  Status: ${item.installation.canonicalStatus} (Single physical target)`);
  } else if (item.installation.canonicalStatus === "AMBIGUOUS") {
    lines.push("  None (Multiple conflicting physical copies exist)");
    lines.push("  Status: AMBIGUOUS (Requires human review before unification)");
  } else {
    lines.push("  None (No physical installation found)");
    lines.push(`  Status: ${item.installation.canonicalStatus}`);
  }
  lines.push("");

  lines.push("Source & Ownership");
  if (item.ownership.length === 0) {
    lines.push("  Ownership: UNTRACKED (Not registered in any lockfile)");
  } else {
    for (const own of item.ownership) {
      lines.push(`  Source:     ${own.source || "unknown"}`);
      if (own.sourceUrl) lines.push(`  Source URL: ${own.sourceUrl}`);
      if (own.lockFile) lines.push(`  Lockfile:   ${own.lockFile}`);
      if (own.installedAt) lines.push(`  Installed:  ${own.installedAt}`);
    }
    lines.push(`  Status:     ${item.ownershipStatus}`);
  }
  lines.push("");

  lines.push("Shared Store (~/.agents/skills)");
  if (item.sharedStore.type === "none") {
    lines.push("  - Not present");
  } else {
    lines.push(`  Type:       ${item.sharedStore.type}`);
    lines.push(`  Path:       ${item.sharedStore.path}`);
    if (item.sharedStore.target) lines.push(`  Target:     ${item.sharedStore.target}`);
    lines.push(`  Visible:    ${item.sharedStore.visible}`);
    if (item.sharedStore.sha256) lines.push(`  SKILL.md:   ${item.sharedStore.sha256.slice(0, 12)}...`);
  }
  lines.push("");

  lines.push("Agent Exposures");
  for (const agent of STANDARD_AGENTS) {
    const exp = item.agentExposures[agent.key];
    if (!exp || exp.type === "none") {
      lines.push(`  ${agent.label.padEnd(12)} - Not installed`);
    } else if (exp.type === "physical") {
      lines.push(`  ${agent.label.padEnd(12)} ✓ Physical directory (visible: ${exp.visible})`);
      lines.push(`               Path: ${exp.path}`);
      if (exp.sha256) lines.push(`               SHA:  ${exp.sha256.slice(0, 12)}...`);
    } else if (exp.type === "symlink") {
      lines.push(`  ${agent.label.padEnd(12)} ↳ Symlink -> ${exp.target || "unknown"} (visible: ${exp.visible})`);
    } else if (exp.type === "broken_symlink") {
      lines.push(`  ${agent.label.padEnd(12)} ! Broken symlink (${exp.path})`);
    } else {
      lines.push(`  ${agent.label.padEnd(12)} ! ${exp.type}`);
    }
  }
  lines.push("");

  lines.push("Usage Breakdown");
  const usageKeys = Object.keys(item.usage);
  if (usageKeys.length === 0) {
    lines.push("  No recorded usage events");
  } else {
    for (const [agent, u] of Object.entries(item.usage)) {
      const lastStr = u.lastUsed ? ` (last: ${u.lastUsed.slice(0, 16).replace("T", " ")})` : "";
      lines.push(`  ${agent.padEnd(12)} ${formatNumber(u.events)} events${lastStr}`);
    }
  }
  lines.push("");

  lines.push("Topology Summary");
  lines.push(`  Physical copies:  ${item.installation.physicalCopies}`);
  lines.push(`  Symlinks:         ${item.installation.symlinks}`);
  lines.push(`  Definition hash:  ${item.installation.definitionHashes.map((h) => h.slice(0, 8)).join(", ") || "none"}`);
  lines.push(`  Statuses:         ${item.statuses.join(", ")}`);

  return `${lines.join("\n")}\n`;
}
