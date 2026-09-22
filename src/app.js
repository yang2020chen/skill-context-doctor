import fs from "node:fs";
import { INTERACTIVE_UNDO, parseArgs, printHelp } from "./args.js";
import { buildAuditReport, formatAuditReport } from "./audit.js";
import { buildRecommendations, formatRecommendationReport } from "./recommend.js";
import {
  applyOptimization,
  formatOptimizeReport,
  planOptimization,
  restoreOptimizationRun,
} from "./optimize.js";
import { formatCleanupResult } from "./cleanup-result.js";
import { shouldUseLinks } from "./format.js";
import { buildRows, payloadFor } from "./model.js";
import { collectSkills, scanEvidence } from "./scan.js";
import { scanSkillsInWorker } from "./scan-worker.js";
import { formatCommands, formatTable, writeCsv, writeSnapshot } from "./output.js";
import { runInteractive, shouldRunInteractive, startInteractiveLoading } from "./interactive.js";
import { runInteractiveUndo } from "./undo-interactive.js";
import { appendOmitPattern, loadOmitPatterns } from "./omit.js";
import { quarantineCandidates, resolveUndoManifest, restoreCleanupRun } from "./quarantine.js";

function write(stream, text) {
  stream.write(text);
}

function printOptimizeRestoreResult(stdout, result) {
  if (result.status === "ALREADY_RESTORED") {
    write(stdout, `Run ${result.runId} has already been restored.\n`);
    return;
  }
  write(stdout, `Restored ${result.restored.length} skills from optimize run ${result.runId}.\n`);
  for (const skill of result.restored) {
    write(stdout, `restored ${skill}\n`);
  }
  for (const conflict of result.conflicts || []) {
    write(
      stdout,
      `conflict: ${conflict.skill} (${conflict.filePath}) was modified after optimize, skipped restore. Backup preserved at ${conflict.backupFile}\n`,
    );
  }
  for (const skipped of result.skipped || []) {
    write(stdout, `skipped ${skipped.skill}: ${skipped.reason}\n`);
  }
}

function printRestoreResult(stdout, result) {
  if (!result.manifest) return;
  write(stdout, `Restored ${result.restored.length} skills from ${result.manifest}.\n`);
  for (const entry of result.restored) {
    write(stdout, `restored ${entry.originalPath}\n`);
  }
  for (const entry of result.skipped) {
    write(stdout, `skipped ${entry.skill}: ${entry.reason}\n`);
  }
  printVercelLockResult(stdout, result.vercelLocks, "restore");
}

function printVercelLockResult(stdout, vercelLocks, action) {
  if (!vercelLocks) return;
  if (vercelLocks.restored?.length) {
    write(stdout, `Vercel skills lock: restored ${vercelLocks.restored.length} entries.\n`);
  }
  if (vercelLocks.removed?.length) {
    write(stdout, `Vercel skills lock: removed ${vercelLocks.removed.length} entries.\n`);
  }
  for (const error of vercelLocks.errors || []) {
    write(stdout, `warning: could not ${action} Vercel skills lock ${error.lockPath}: ${error.error}\n`);
  }
}

function restrictCleanupToRecommendations(rows, recommendations) {
  const bySkill = new Map(recommendations.map((item) => [item.skill, item]));
  return rows.map((row) => {
    const recommendation = bySkill.get(row.skill);
    const cleanupEligible =
      Boolean(row.cleanup_candidate) && recommendation?.action === "REMOVE CANDIDATE";
    if (cleanupEligible) return { ...row, cleanup_eligible: true };
    if (!row.cleanup_candidate) return { ...row, cleanup_eligible: false };
    return {
      ...row,
      cleanup_eligible: false,
      cleanup_candidate: false,
      cleanup_reason: `requires review: ${recommendation?.action || "NO_RECOMMENDATION"}`,
      risk: "protected",
    };
  });
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const now = io.now || new Date();
  const options = parseArgs(argv);

  if (options.help) {
    write(stdout, printHelp());
    return null;
  }

  if (options.version) {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    write(stdout, `${pkg.version}\n`);
    return null;
  }

  if (options.command === "omit") {
    const results = options.commandArgs.map((pattern) => appendOmitPattern(options, pattern));
    for (const result of results) {
      write(
        stdout,
        result.alreadyPresent
          ? `Already omitted ${result.pattern} in ${result.file}.\n`
          : `Omitted ${result.pattern} in ${result.file}.\n`,
      );
    }
    return { omit: results };
  }

  if (options.undo === INTERACTIVE_UNDO) {
    const result = await runInteractiveUndo(options, io);
    if (result?.undo) {
      if (result.undo.status === "restored" || result.undo.status === "ALREADY_RESTORED") {
        printOptimizeRestoreResult(stdout, result.undo);
      } else {
        printRestoreResult(stdout, result.undo);
      }
    }
    return result;
  }

  if (options.undo) {
    const manifestFile = resolveUndoManifest(options.stateDir, options.undo);
    let isOptimize = false;
    try {
      const manifestData = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      isOptimize = manifestData.type === "optimize";
    } catch {}

    if (isOptimize) {
      const result = restoreOptimizationRun(options.stateDir, manifestFile);
      printOptimizeRestoreResult(stdout, result);
      return result;
    }

    const result = restoreCleanupRun(options.stateDir, options.undo);
    printRestoreResult(stdout, result);
    return result;
  }

  const interactive = shouldRunInteractive(options, io);
  const loading = startInteractiveLoading(options, io);
  let skills;
  let scanStats;
  try {
    if (interactive) {
      const result = await scanSkillsInWorker(
        { ...options, now },
        (progress) => loading?.update(progress),
      );
      skills = result.skills;
      scanStats = result.stats;
    } else {
      skills = collectSkills(options.skillsDirs);
      const scanEvidenceOptions =
        options.command === "recommend" || options.command === "optimize"
          ? { ...options, source: "all", now }
          : { ...options, now };
      scanStats = await scanEvidence(skills, scanEvidenceOptions);
    }
  } finally {
    loading?.stop();
  }
  const omitPatterns = loadOmitPatterns(options);
  const modelOptions = { ...options, now, omitPatterns };
  let rows = buildRows(skills, modelOptions);
  if (!options.command || options.command === "cleanup") {
    const cleanupAudit = buildAuditReport(skills, rows, { ...options, now });
    const cleanupRecommendations = buildRecommendations(cleanupAudit, { ...options, now });
    rows = restrictCleanupToRecommendations(rows, cleanupRecommendations.recommendations);
  }
  const payload = payloadFor(rows, modelOptions, scanStats, now);

  if (options.command === "audit") {
    const auditReport = buildAuditReport(skills, rows, { ...options, now });
    if (options.json) {
      write(stdout, `${JSON.stringify(auditReport, null, 2)}\n`);
    } else {
      write(stdout, formatAuditReport(auditReport, { ...options, now }));
    }
    return auditReport;
  }

  if (options.command === "recommend") {
    const auditReport = buildAuditReport(skills, rows, { ...options, now });
    const recReport = buildRecommendations(auditReport, {
      ...options,
      now,
      displaySource: options.source !== "all" ? options.source : null,
    });
    if (options.json) {
      write(stdout, `${JSON.stringify(recReport, null, 2)}\n`);
    } else {
      write(stdout, formatRecommendationReport(recReport, { ...options, now }));
    }
    return recReport;
  }

  if (options.command === "optimize") {
    const auditReport = buildAuditReport(skills, rows, { ...options, now });
    const recReport = buildRecommendations(auditReport, {
      ...options,
      now,
      displaySource: options.source !== "all" ? options.source : null,
    });
    const plan = planOptimization(auditReport, recReport, skills, {
      ...options,
      now,
      displaySource: options.source !== "all" ? options.source : null,
    });

    if (options.apply) {
      const applyResult = applyOptimization(plan, { ...options, now });
      if (options.json) {
        write(stdout, `${JSON.stringify(applyResult, null, 2)}\n`);
      } else {
        write(stdout, formatOptimizeReport(applyResult, options));
      }
      return applyResult;
    }

    if (options.json) {
      write(stdout, `${JSON.stringify(plan, null, 2)}\n`);
    } else {
      write(stdout, formatOptimizeReport(plan, options));
    }
    return plan;
  }

  if (options.csv) writeCsv(options.csv, rows);
  if (options.snapshot) writeSnapshot(options.snapshot, payload, options);

  if (interactive) {
    const interactiveResult = await runInteractive(
      rows,
      payload,
      { ...options, now, recentNewChats: payload.summary.recentNewChats },
      io,
    );
    if (interactiveResult) return interactiveResult;
  }

  if (options.apply) {
    const result = quarantineCandidates(rows, {
      ...options,
      now,
      recentNewChats: payload.summary.recentNewChats,
    });
    write(
      stdout,
      formatCleanupResult(result, {
        stdout,
        savingsDays: options.savingsDays,
        recentNewChats: payload.summary.recentNewChats,
      }),
    );
  } else if (options.commands) {
    write(stdout, formatCommands(rows));
  } else if (options.json) {
    write(stdout, `${JSON.stringify(payload, null, 2)}\n`);
  } else {
    write(stdout, formatTable(rows, options.limit, {
      links: shouldUseLinks(stdout),
      savingsDays: options.savingsDays,
      recentNewChats: payload.summary.recentNewChats,
    }));
    write(
      stdout,
      `\nScanned ${payload.summary.parsedRecords} matching records in ${payload.summary.scanMs}ms (${payload.summary.matchedLines} matching lines).\n`,
    );
  }

  return payload;
}
