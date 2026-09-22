import { INTERACTIVE_UNDO, parseArgs, printHelp } from "./args.js";
import { buildAuditReport, formatAuditReport } from "./audit.js";
import { buildRecommendations, formatRecommendationReport } from "./recommend.js";
import { formatCleanupResult } from "./cleanup-result.js";
import { shouldUseLinks } from "./format.js";
import { buildRows, payloadFor } from "./model.js";
import { collectSkills, scanEvidence } from "./scan.js";
import { scanSkillsInWorker } from "./scan-worker.js";
import { formatCommands, formatTable, writeCsv, writeSnapshot } from "./output.js";
import { runInteractive, shouldRunInteractive, startInteractiveLoading } from "./interactive.js";
import { runInteractiveUndo } from "./undo-interactive.js";
import { appendOmitPattern, loadOmitPatterns } from "./omit.js";
import { quarantineCandidates, restoreCleanupRun } from "./quarantine.js";

function write(stream, text) {
  stream.write(text);
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

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const now = io.now || new Date();
  const options = parseArgs(argv);

  if (options.help) {
    write(stdout, printHelp());
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
    if (result?.undo) printRestoreResult(stdout, result.undo);
    return result;
  }

  if (options.undo) {
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
        options.command === "recommend" ? { ...options, source: "all", now } : { ...options, now };
      scanStats = await scanEvidence(skills, scanEvidenceOptions);
    }
  } finally {
    loading?.stop();
  }
  const omitPatterns = loadOmitPatterns(options);
  const modelOptions = { ...options, now, omitPatterns };
  const rows = buildRows(skills, modelOptions);
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
