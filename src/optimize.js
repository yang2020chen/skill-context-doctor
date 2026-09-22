import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandHome } from "./args.js";
import { formatNumber } from "./format.js";
import { isKeepProtected, loadKeepNames } from "./keep.js";
import { renderLogo } from "./logo.js";

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function formatTokens(count) {
  const number = Number(count) || 0;
  if (number >= 1000) {
    const k = (number / 1000).toFixed(1);
    return `~${k}K`;
  }
  return `${number}`;
}

/**
 * Conservative frontmatter patcher for disable-model-invocation: true.
 * Preserves UTF-8 BOM, newline conventions (CRLF vs LF), and all existing comments/content.
 *
 * @param {Buffer} rawBuffer Raw file content
 * @returns {object} { success: boolean, buffer: Buffer, beforeValue, afterValue, alreadyDisabled?, reason? }
 */
export function patchFrontmatterDisableModel(rawBuffer) {
  if (!Buffer.isBuffer(rawBuffer)) {
    rawBuffer = Buffer.from(String(rawBuffer || ""));
  }

  // Detect and strip UTF-8 BOM if present
  let hasBom = false;
  let workBuffer = rawBuffer;
  if (
    rawBuffer.length >= 3 &&
    rawBuffer[0] === 0xef &&
    rawBuffer[1] === 0xbb &&
    rawBuffer[2] === 0xbf
  ) {
    hasBom = true;
    workBuffer = rawBuffer.subarray(3);
  }

  const content = workBuffer.toString("utf8");
  const isCrlf = content.includes("\r\n");
  const eol = isCrlf ? "\r\n" : "\n";

  // Check for starting frontmatter
  if (content.startsWith("---")) {
    const openMatch = content.match(/^---(?:\r?\n|$)/);
    if (!openMatch) {
      return { success: false, reason: "MALFORMED_FRONTMATTER" };
    }

    const afterOpen = content.slice(openMatch[0].length);
    const closeIndex = afterOpen.search(/(?:\r?\n|^)---(?:\r?\n|$)/);
    if (closeIndex === -1) {
      return { success: false, reason: "UNCLOSED_FRONTMATTER" };
    }

    const frontmatterBody = afterOpen.slice(0, closeIndex);
    const restOfDoc = afterOpen.slice(closeIndex);

    // Analyze disable-model-invocation lines in frontmatterBody
    const lines = frontmatterBody.split(/\r?\n/);
    const dmiIndices = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (/^disable-model-invocation:\s*(.*)$/.test(line)) {
        dmiIndices.push(i);
      }
    }

    if (dmiIndices.length > 1) {
      return { success: false, reason: "DUPLICATE_DISABLE_MODEL_INVOCATION" };
    }

    let beforeValue = false;
    let newFrontmatterBody = "";

    if (dmiIndices.length === 1) {
      const idx = dmiIndices[0];
      const match = lines[idx].match(/^disable-model-invocation:\s*(.*)$/);
      const rawVal = match[1].trim().toLowerCase();

      if (rawVal !== "true" && rawVal !== "false") {
        return { success: false, reason: "INVALID_BOOLEAN_VALUE" };
      }

      beforeValue = rawVal === "true";
      if (beforeValue) {
        return {
          success: true,
          buffer: rawBuffer,
          beforeValue: true,
          afterValue: true,
          alreadyDisabled: true,
        };
      }

      lines[idx] = "disable-model-invocation: true";
      newFrontmatterBody = lines.join(eol);
    } else {
      // Append field inside frontmatter
      const trimmed = frontmatterBody.trimEnd();
      newFrontmatterBody = `${trimmed ? `${trimmed}${eol}` : ""}disable-model-invocation: true`;
    }

    const newContent = `---${eol}${newFrontmatterBody}${restOfDoc}`;
    const newWorkBuffer = Buffer.from(newContent, "utf8");
    const finalBuffer = hasBom
      ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), newWorkBuffer])
      : newWorkBuffer;

    return {
      success: true,
      buffer: finalBuffer,
      beforeValue,
      afterValue: true,
    };
  }

  // No frontmatter present -> prepend minimal frontmatter
  const newContent = `---${eol}disable-model-invocation: true${eol}---${eol}${eol}${content}`;
  const newWorkBuffer = Buffer.from(newContent, "utf8");
  const finalBuffer = hasBom
    ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), newWorkBuffer])
    : newWorkBuffer;

  return {
    success: true,
    buffer: finalBuffer,
    beforeValue: false,
    afterValue: true,
  };
}

/**
 * Plans optimization by grouping skills by canonical target realpath,
 * checking keep whitelists, verifying multi-identity agreement, and preflighting frontmatter.
 *
 * @param {object} auditReport Output from buildAuditReport
 * @param {object} recReport Output from buildRecommendations
 * @param {Map} skills Map from collectSkills
 * @param {object} options Command options
 * @returns {object} Structured optimization plan
 */
export function planOptimization(auditReport, recReport, skills, options = {}) {
  const keepNames = loadKeepNames(options);
  const recMap = new Map((recReport?.recommendations || []).map((r) => [r.skill, r]));

  // Group all installed skills by canonical realpath
  const canonicalMap = new Map(); // realpath -> { canonicalFilePath, identities: Set, usages: [] }
  const skillToRealpaths = new Map(); // skillName -> Set of realpaths

  const skillList =
    skills instanceof Map ? Array.from(skills.values()) : Array.isArray(skills) ? skills : [];

  for (const usage of skillList) {
    const rawPath = usage.path;
    let realPath = usage.realPath;
    if (!realPath && fs.existsSync(rawPath)) {
      try {
        realPath = fs.realpathSync(rawPath);
      } catch {
        realPath = path.resolve(rawPath);
      }
    }
    if (!realPath) realPath = path.resolve(rawPath);

    let canonicalEntry = canonicalMap.get(realPath);
    if (!canonicalEntry) {
      canonicalEntry = {
        canonicalFilePath: realPath,
        identities: new Set(),
        usages: [],
      };
      canonicalMap.set(realPath, canonicalEntry);
    }
    canonicalEntry.identities.add(usage.skill);
    canonicalEntry.usages.push(usage);

    let realpathsSet = skillToRealpaths.get(usage.skill);
    if (!realpathsSet) {
      realpathsSet = new Set();
      skillToRealpaths.set(usage.skill, realpathsSet);
    }
    realpathsSet.add(realPath);
  }

  const planned = [];
  const skipped = [];
  const protectedByKeep = [];

  const onlyNames = new Set(
    (options.only || options.onlyPatterns || []).map((s) => String(s).trim()).filter(Boolean),
  );

  for (const [realPath, entry] of canonicalMap.entries()) {
    const identities = [...entry.identities];
    const primarySkill = identities[0];

    // Check if filtered by --only
    if (onlyNames.size > 0 && !identities.some((name) => onlyNames.has(name))) {
      continue;
    }

    // Check if any identity is in keep whitelist
    const keepMatched = identities.find((name) => isKeepProtected(name, keepNames));
    if (keepMatched) {
      protectedByKeep.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: `Protected by keep (${keepMatched})`,
      });
      continue;
    }

    // Check if any identity has distinct realpaths (true duplicate on disk)
    const hasMultipleRealpaths = identities.some(
      (name) => (skillToRealpaths.get(name)?.size || 0) > 1,
    );
    if (hasMultipleRealpaths) {
      skipped.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: "DUPLICATE_INSTALLATION",
      });
      continue;
    }

    // Multi-identity agreement check:
    // ALL identities resolving to this target must have recommendation === HIDE and high/medium confidence
    let allHide = true;
    let conflictReason = "";

    for (const name of identities) {
      const rec = recMap.get(name);
      if (!rec) {
        allHide = false;
        conflictReason = `No recommendation found for ${name}`;
        break;
      }
      if (rec.action !== "HIDE") {
        allHide = false;
        conflictReason = `Identity ${name} is ${rec.action}, not HIDE`;
        break;
      }
      if (rec.confidence === "low") {
        allHide = false;
        conflictReason = `Identity ${name} has low confidence recommendation`;
        break;
      }
    }

    if (!allHide) {
      skipped.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: identities.length > 1 ? "CANONICAL_TARGET_CONFLICT" : conflictReason,
        conflictDetails: conflictReason,
      });
      continue;
    }

    // Preflight file reading and conservative frontmatter patch
    if (!fs.existsSync(realPath)) {
      skipped.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: "TARGET_FILE_MISSING",
      });
      continue;
    }

    let rawBuffer;
    let stat;
    try {
      rawBuffer = fs.readFileSync(realPath);
      stat = fs.statSync(realPath);
    } catch (error) {
      skipped.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: `READ_ERROR: ${error?.message || error}`,
      });
      continue;
    }

    const patchResult = patchFrontmatterDisableModel(rawBuffer);
    if (!patchResult.success) {
      skipped.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: `FRONTMATTER_ERROR: ${patchResult.reason}`,
      });
      continue;
    }

    if (patchResult.alreadyDisabled) {
      // Already disabled, no modification required
      skipped.push({
        skill: primarySkill,
        canonicalFilePath: realPath,
        identities,
        reason: "ALREADY_DISABLED",
      });
      continue;
    }

    const primaryRec = recMap.get(primarySkill) || {};
    const sha256Before = sha256Buffer(rawBuffer);
    const sha256After = sha256Buffer(patchResult.buffer);

    const plannedItem = {
      skill: primarySkill,
      identities,
      canonicalFilePath: realPath,
      observedPaths: entry.usages.map((u) => u.path),
      sha256Before,
      sha256After,
      modeBefore: stat.mode,
      sizeBefore: stat.size,
      estimatedTokenSavings: primaryRec.visibleTokens || 0,
      reasonCodes: primaryRec.reasons || ["MODEL_VISIBLE", "NEVER_USED"],
      confidence: primaryRec.confidence || "high",
    };
    Object.defineProperty(plannedItem, "rawBuffer", { value: rawBuffer, enumerable: false, writable: true });
    Object.defineProperty(plannedItem, "newBuffer", { value: patchResult.buffer, enumerable: false, writable: true });
    Object.defineProperty(plannedItem, "_rawBuffer", { value: rawBuffer, enumerable: false, writable: true });
    Object.defineProperty(plannedItem, "_newBuffer", { value: patchResult.buffer, enumerable: false, writable: true });
    planned.push(plannedItem);
  }

  // If --limit N is explicitly passed, take top N items by highest token savings
  let finalPlanned = planned;
  if (options.limitExplicit && options.limit > 0 && planned.length > options.limit) {
    finalPlanned = [...planned]
      .sort((a, b) => b.estimatedTokenSavings - a.estimatedTokenSavings)
      .slice(0, options.limit);
  }

  const totalSavings = finalPlanned.reduce((acc, item) => acc + item.estimatedTokenSavings, 0);
  const removalCandidates = (recReport?.recommendations || []).filter(
    (r) => r.action === "REMOVE CANDIDATE",
  );

  return {
    command: "optimize",
    mode: "dry-run",
    summary: {
      plannedCount: finalPlanned.length,
      skippedCount: skipped.length,
      protectedByKeepCount: protectedByKeep.length,
      removalCandidateCount: removalCandidates.length,
      estimatedTokenSavings: totalSavings,
    },
    planned: finalPlanned,
    skipped,
    protectedByKeep,
    removalCandidates,
    analysisScope: "all",
    displaySource: options.displaySource || null,
  };
}

/**
 * Executes two-phase atomic optimization transaction:
 * Phase 1 (PREPARE): Writes backups and immutable manifest.json.
 * Phase 2 (APPLY): Pre-checks hashes, writes via tmpfile -> fsync -> rename, and rolls back on error.
 *
 * @param {object} plan Planned optimization object
 * @param {object} options Command options
 * @returns {object} Execution result
 */
export function applyOptimization(plan, options = {}) {
  const stateDir = path.resolve(
    expandHome(options.stateDir || "~/.local/state/skill-context-doctor"),
  );
  const now = options.now || new Date();
  const dateStr = now.toISOString().replace(/[-:]/g, "").slice(0, 15).replace("T", "-");
  const shortId = crypto.randomBytes(3).toString("hex");
  const runId = `${dateStr}-${shortId}`;
  const runDir = path.join(stateDir, "runs", runId);
  const backupsDir = path.join(runDir, "backups");

  fs.mkdirSync(backupsDir, { recursive: true });

  // Phase 1: PREPARE - write byte-exact backups and manifest.json
  const manifestEntries = [];
  for (let idx = 0; idx < plan.planned.length; idx += 1) {
    const item = plan.planned[idx];
    const backupFileName = `${String(idx + 1).padStart(4, "0")}-${item.skill.replace(/[\/\\:]/g, "_")}-SKILL.md`;
    const backupRelPath = path.join("backups", backupFileName);
    const backupFullPath = path.join(runDir, backupRelPath);

    fs.writeFileSync(backupFullPath, item.rawBuffer);

    manifestEntries.push({
      skill: item.skill,
      action: "HIDE",
      identities: item.identities,
      canonicalFilePath: item.canonicalFilePath,
      observedPaths: item.observedPaths,
      backupFile: backupRelPath,
      sha256Before: item.sha256Before,
      sha256After: item.sha256After,
      modeBefore: item.modeBefore,
      sizeBefore: item.sizeBefore,
      reasonCodes: item.reasonCodes,
      confidence: item.confidence,
      estimatedTokenSavings: item.estimatedTokenSavings,
      _newBuffer: item.newBuffer, // Memory-only reference for Phase 2
    });
  }

  const manifest = {
    schemaVersion: 1,
    toolVersion: "0.3.0",
    type: "optimize",
    id: runId,
    createdAt: now.toISOString(),
    analysisScope: "all",
    command: "optimize --apply",
    stateDir,
    summary: {
      plannedCount: plan.summary.plannedCount,
      estimatedTokenSavings: plan.summary.estimatedTokenSavings,
    },
    entries: manifestEntries.map(({ _newBuffer, ...entry }) => entry),
  };

  const manifestFilePath = path.join(runDir, "manifest.json");
  fs.writeFileSync(manifestFilePath, `${JSON.stringify(manifest, null, 2)}\n`);

  // Phase 2: PRE-CHECK all files before modifying any target
  for (const entry of manifestEntries) {
    if (!fs.existsSync(entry.canonicalFilePath)) {
      return recordAbort(runDir, manifest, "MISSING_TARGET_FILE_BEFORE_APPLY", entry);
    }
    const currentBytes = fs.readFileSync(entry.canonicalFilePath);
    const currentHash = sha256Buffer(currentBytes);
    if (currentHash !== entry.sha256Before) {
      return recordAbort(runDir, manifest, "HASH_MISMATCH_BEFORE_APPLY", entry);
    }
  }

  // Phase 2: APPLY with crash-resilient write & rollback
  const modifiedEntries = [];
  let failureError = null;
  let failedEntry = null;

  for (let idx = 0; idx < manifestEntries.length; idx += 1) {
    const entry = manifestEntries[idx];
    try {
      // Re-verify hash immediately before write
      const currentBytes = fs.readFileSync(entry.canonicalFilePath);
      if (sha256Buffer(currentBytes) !== entry.sha256Before) {
        throw new Error(`Hash mismatch immediately before rename for ${entry.canonicalFilePath}`);
      }

      // 1. Write tmp file in parent directory
      const tmpPath = path.join(
        path.dirname(entry.canonicalFilePath),
        `.${path.basename(entry.canonicalFilePath)}.tmp-${shortId}-${idx}`,
      );
      fs.writeFileSync(tmpPath, entry._newBuffer);

      // 2. fsync tmp file
      const fdTmp = fs.openSync(tmpPath, "r+");
      fs.fsyncSync(fdTmp);
      fs.closeSync(fdTmp);

      // 3. chmod tmp file to match original mode
      try {
        fs.chmodSync(tmpPath, entry.modeBefore);
      } catch {}

      // 4. rename tmp file to target
      fs.renameSync(tmpPath, entry.canonicalFilePath);

      // 5. fsync parent directory
      try {
        const fdDir = fs.openSync(path.dirname(entry.canonicalFilePath), "r");
        fs.fsyncSync(fdDir);
        fs.closeSync(fdDir);
      } catch {}

      modifiedEntries.push(entry);
    } catch (err) {
      failureError = err;
      failedEntry = entry;
      break;
    }
  }

  // If failure occurred during writes, execute automatic rollback
  if (failureError) {
    const rollbackFailures = [];
    for (const entry of modifiedEntries) {
      try {
        const backupFullPath = path.join(runDir, entry.backupFile);
        const backupBytes = fs.readFileSync(backupFullPath);
        fs.writeFileSync(entry.canonicalFilePath, backupBytes);
        try {
          fs.chmodSync(entry.canonicalFilePath, entry.modeBefore);
        } catch {}
      } catch (rbErr) {
        rollbackFailures.push({
          skill: entry.skill,
          filePath: entry.canonicalFilePath,
          backupPath: path.join(runDir, entry.backupFile),
          error: rbErr?.message || String(rbErr),
        });
      }
    }

    const status = rollbackFailures.length === 0 ? "aborted_rolled_back" : "rollback_incomplete";
    const resultPayload = {
      status,
      runId,
      error: failureError.message,
      failedSkill: failedEntry?.skill,
      failedFilePath: failedEntry?.canonicalFilePath,
      modifiedCountBeforeAbort: modifiedEntries.length,
      rollbackFailures,
      appliedAt: now.toISOString(),
    };

    fs.writeFileSync(
      path.join(runDir, "result.json"),
      `${JSON.stringify(resultPayload, null, 2)}\n`,
    );

    return {
      success: false,
      status,
      runId,
      runDir,
      manifest,
      result: resultPayload,
      error: failureError,
    };
  }

  // Success: write result.json and update latest.json
  const resultPayload = {
    status: "applied",
    runId,
    appliedAt: new Date().toISOString(),
    appliedCount: manifestEntries.length,
    estimatedTokenSavings: plan.summary.estimatedTokenSavings,
  };

  fs.writeFileSync(
    path.join(runDir, "result.json"),
    `${JSON.stringify(resultPayload, null, 2)}\n`,
  );

  fs.writeFileSync(
    path.join(stateDir, "latest.json"),
    `${JSON.stringify({ runId, runDir, manifest: path.join(runDir, "manifest.json"), type: "optimize" }, null, 2)}\n`,
  );

  return {
    command: "optimize",
    mode: "apply",
    success: true,
    status: "applied",
    runId,
    runDir,
    manifest,
    result: resultPayload,
  };
}

function recordAbort(runDir, manifest, reason, entry) {
  const resultPayload = {
    status: "aborted_rolled_back",
    runId: manifest.id,
    reason,
    failedSkill: entry.skill,
    failedFilePath: entry.canonicalFilePath,
    modifiedCountBeforeAbort: 0,
    rollbackFailures: [],
  };
  fs.writeFileSync(path.join(runDir, "result.json"), `${JSON.stringify(resultPayload, null, 2)}\n`);
  return {
    success: false,
    status: "aborted_rolled_back",
    runId: manifest.id,
    runDir,
    manifest,
    result: resultPayload,
    error: new Error(`Phase 2 aborted: ${reason} on ${entry.canonicalFilePath}`),
  };
}

/**
 * Restores an optimization run safely.
 * Only permits restoring successful runs (status === "applied").
 * Verifies current file hash matches sha256After to prevent overwriting subsequent user edits.
 *
 * @param {string} stateDir State directory
 * @param {string} undoTarget Target run ID or "latest"
 * @returns {object} Undo result
 */
export function restoreOptimizationRun(stateDir, undoTarget) {
  const resolvedStateDir = path.resolve(expandHome(stateDir));
  let runDir = "";

  if (!undoTarget || undoTarget === "latest") {
    const latestFile = path.join(resolvedStateDir, "latest.json");
    if (fs.existsSync(latestFile)) {
      try {
        const latestData = JSON.parse(fs.readFileSync(latestFile, "utf8"));
        if (latestData?.runDir && fs.existsSync(latestData.runDir)) {
          runDir = latestData.runDir;
        }
      } catch {}
    }
  } else if (undoTarget.includes("/") || fs.existsSync(undoTarget)) {
    runDir = fs.statSync(undoTarget).isDirectory() ? undoTarget : path.dirname(undoTarget);
  } else {
    runDir = path.join(resolvedStateDir, "runs", undoTarget);
  }

  if (!runDir || !fs.existsSync(runDir)) {
    throw new Error(`Run directory not found for undo target: ${undoTarget || "latest"}`);
  }

  const manifestFile = path.join(runDir, "manifest.json");
  if (!fs.existsSync(manifestFile)) {
    throw new Error(`manifest.json not found in run directory: ${runDir}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.type !== "optimize") {
    throw new Error(`Run ${manifest.id} is not an optimize run (type: ${manifest.type})`);
  }

  // Check result.json
  const resultFile = path.join(runDir, "result.json");
  if (!fs.existsSync(resultFile)) {
    throw new Error(`result.json not found in run directory: ${runDir}`);
  }
  const resultData = JSON.parse(fs.readFileSync(resultFile, "utf8"));
  if (resultData.status !== "applied") {
    throw new Error(`Cannot undo run with status '${resultData.status}' (only 'applied' runs can be undone)`);
  }

  // Check if already restored
  const restoreFile = path.join(runDir, "restore.json");
  if (fs.existsSync(restoreFile)) {
    return {
      status: "ALREADY_RESTORED",
      runId: manifest.id,
      runDir,
      restored: [],
      conflicts: [],
      skipped: [],
    };
  }

  const restored = [];
  const conflicts = [];
  const skipped = [];

  for (const entry of manifest.entries) {
    if (!fs.existsSync(entry.canonicalFilePath)) {
      skipped.push({
        skill: entry.skill,
        filePath: entry.canonicalFilePath,
        reason: "FILE_MISSING",
      });
      continue;
    }

    const currentBytes = fs.readFileSync(entry.canonicalFilePath);
    const currentHash = sha256Buffer(currentBytes);

    // Anti-conflict gate: verify current hash matches sha256After
    if (currentHash !== entry.sha256After) {
      conflicts.push({
        skill: entry.skill,
        filePath: entry.canonicalFilePath,
        reason: "CONFLICT_AFTER_OPTIMIZE",
        currentSha256: currentHash,
        expectedSha256: entry.sha256After,
        backupFile: path.join(runDir, entry.backupFile),
      });
      continue;
    }

    // Hash matches -> safe to restore from backup
    const backupFullPath = path.join(runDir, entry.backupFile);
    if (!fs.existsSync(backupFullPath)) {
      skipped.push({
        skill: entry.skill,
        filePath: entry.canonicalFilePath,
        reason: "BACKUP_FILE_MISSING",
      });
      continue;
    }

    const backupBytes = fs.readFileSync(backupFullPath);
    const tmpPath = path.join(
      path.dirname(entry.canonicalFilePath),
      `.${path.basename(entry.canonicalFilePath)}.tmp-undo`,
    );

    fs.writeFileSync(tmpPath, backupBytes);
    try {
      fs.chmodSync(tmpPath, entry.modeBefore);
    } catch {}
    fs.renameSync(tmpPath, entry.canonicalFilePath);

    try {
      const fdDir = fs.openSync(path.dirname(entry.canonicalFilePath), "r");
      fs.fsyncSync(fdDir);
      fs.closeSync(fdDir);
    } catch {}

    restored.push(entry.skill);
  }

  const restorePayload = {
    status: "restored",
    runId: manifest.id,
    restoredAt: new Date().toISOString(),
    restoredCount: restored.length,
    conflictCount: conflicts.length,
    skippedCount: skipped.length,
    restored,
    conflicts,
    skipped,
  };

  fs.writeFileSync(restoreFile, `${JSON.stringify(restorePayload, null, 2)}\n`);

  return {
    status: "restored",
    runId: manifest.id,
    runDir,
    restored,
    conflicts,
    skipped,
  };
}

/**
 * Formats the optimization plan and execution output for terminal display.
 *
 * @param {object} planOrResult Plan or execution result
 * @param {object} options Command options
 * @returns {string} Text report
 */
export function formatOptimizeReport(planOrResult, options = {}) {
  const isApplied = Boolean(options.apply && planOrResult.result?.status === "applied");
  const isRolledBack = Boolean(planOrResult.result?.status?.startsWith("aborted") || planOrResult.result?.status?.startsWith("rollback"));
  const summary = planOrResult.summary || planOrResult.manifest?.summary || {};

  const lines = [renderLogo(), ""];

  if (isRolledBack) {
    lines.push("Skill Context Doctor - Optimize (ABORTED & ROLLED BACK)");
    lines.push(`Status: ${planOrResult.result.status}`);
    lines.push(`Reason: ${planOrResult.result.error || planOrResult.result.reason}`);
    lines.push(`Action Manifest: ${path.join(planOrResult.runDir, "manifest.json")}`);
    lines.push("");
    if (planOrResult.result.rollbackFailures?.length > 0) {
      lines.push("⚠️ Rollback Incomplete for the following files:");
      for (const fail of planOrResult.result.rollbackFailures) {
        lines.push(`  • ${fail.filePath}: ${fail.error} (Backup: ${fail.backupPath})`);
      }
      lines.push("");
    }
    return `${lines.join("\n")}\n`;
  }

  if (isApplied) {
    lines.push("Skill Context Doctor - Optimize (Executed)");
    lines.push(`Action Manifest: ${path.join(planOrResult.runDir, "manifest.json")}`);
    lines.push("");
    lines.push("Summary");
    lines.push(`  Modified (HIDE):       ${formatNumber(planOrResult.result.appliedCount)}`);
    lines.push(
      `  Context tokens saved:  ${formatTokens(planOrResult.result.estimatedTokenSavings)} tokens (${formatNumber(planOrResult.result.estimatedTokenSavings)} tokens)`,
    );
    lines.push("");
    lines.push("Backups stored in run directory. To revert these changes, run:");
    lines.push("  skill-context-doctor undo latest");
    lines.push("");
    return `${lines.join("\n")}\n`;
  }

  // Dry run report
  lines.push("Skill Context Doctor - Optimize (Dry Run)");
  lines.push("Target: Hide model-visible skills that are unused or heavy stale");
  lines.push("");
  lines.push("Planned Actions (HIDE)");
  lines.push(`  Skills to hide:        ${formatNumber(summary.plannedCount || 0)}`);
  lines.push(
    `  Estimated savings:     ${formatTokens(summary.estimatedTokenSavings || 0)} tokens (${formatNumber(summary.estimatedTokenSavings || 0)} tokens)`,
  );
  lines.push(`  Protected by --keep:   ${formatNumber(summary.protectedByKeepCount || 0)}`);
  lines.push(`  Skipped (review/dup):  ${formatNumber(summary.skippedCount || 0)}`);
  lines.push("");

  if (planOrResult.planned?.length > 0) {
    lines.push("High Impact Skills to Hide:");
    lines.push("");
    lines.push("Skill                            Visible Tokens   Confidence   Reasons");
    lines.push(
      "------------------------------   --------------   ----------   ----------------------------------------",
    );
    const topPlanned = [...planOrResult.planned]
      .sort((a, b) => b.estimatedTokenSavings - a.estimatedTokenSavings)
      .slice(0, 10);
    for (const item of topPlanned) {
      const name = item.skill.length > 30 ? `${item.skill.slice(0, 27)}...` : item.skill.padEnd(30);
      const tokens = String(formatNumber(item.estimatedTokenSavings)).padStart(14);
      const conf = item.confidence.padEnd(10);
      const reasons = item.reasonCodes.join(", ");
      lines.push(`${name}   ${tokens}   ${conf}   ${reasons}`);
    }
    lines.push("");
  }

  if (summary.removalCandidateCount > 0) {
    lines.push("Removal Candidates (Manual Review)");
    lines.push(
      `  ${formatNumber(summary.removalCandidateCount)} removal candidates available (already hidden & never used).`,
    );
    lines.push("  Use `skill-context-doctor cleanup` to review and quarantine them.");
    lines.push("");
  }

  lines.push("No files changed. Run with --apply to execute.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
