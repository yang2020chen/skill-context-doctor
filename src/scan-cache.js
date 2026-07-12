import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SCHEMA_VERSION = 1;
const PARSER_VERSION = 1;

export function inventorySignature(skills) {
  const inventory = [...skills.values()]
    .map(({ id, path: skillPath, realPath, skill }) => ({ id, path: skillPath, realPath, skill }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return crypto.createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
}

export function fileFingerprint(file) {
  try {
    const stat = fs.statSync(file);
    return {
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    };
  } catch {
    return null;
  }
}

function sameFingerprint(left, right) {
  return left?.ino === right?.ino && left?.mtimeMs === right?.mtimeMs && left?.size === right?.size;
}

function readCache(cacheFile, signature) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (
      parsed.schemaVersion !== SCHEMA_VERSION ||
      parsed.parserVersion !== PARSER_VERSION ||
      parsed.inventorySignature !== signature ||
      !parsed.modes ||
      typeof parsed.modes !== "object"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function serializeEvidence(evidence) {
  return {
    ...evidence,
    ts: evidence.ts instanceof Date ? evidence.ts.toISOString() : evidence.ts || null,
  };
}

function hydrateEvidence(evidence) {
  const ts = evidence.ts ? new Date(evidence.ts) : null;
  return {
    ...evidence,
    ts: ts && !Number.isNaN(ts.getTime()) ? ts : null,
  };
}

function normalizedFile(file) {
  return path.resolve(file);
}

export function snapshotEvidenceLengths(skills) {
  return new Map(
    [...skills].map(([id, usage]) => [id, {
      mentions: usage.mentions.length,
      usageEvents: usage.usageEvents.length,
    }]),
  );
}

export function createScanCache(skills, options = {}) {
  const signature = inventorySignature(skills);
  const cacheFile = options.cacheFile || path.join(options.stateDir, "scan-cache-v1.json");
  const mode = options.fullScan ? "full" : "prefilter";
  const enabled = options.cache !== false;
  const loaded = enabled ? readCache(cacheFile, signature) : null;
  const currentFiles = { ...(loaded?.modes?.[mode]?.files || {}) };

  function partitionFiles(source, kind, files) {
    const normalized = [...new Set(files.map(normalizedFile))];
    const present = new Set(normalized);
    for (const [file, entry] of Object.entries(currentFiles)) {
      if (entry.source === source && entry.kind === kind && !present.has(file)) {
        delete currentFiles[file];
      }
    }

    const cached = [];
    const dirty = [];
    for (const file of normalized) {
      const fingerprint = fileFingerprint(file);
      const entry = currentFiles[file];
      if (enabled && fingerprint && entry?.source === source && entry.kind === kind && sameFingerprint(entry.fingerprint, fingerprint)) {
        cached.push({ file, entry });
        continue;
      }
      delete currentFiles[file];
      dirty.push(file);
    }
    return { cached, dirty };
  }

  function replay(entries, targetSkills = skills) {
    let count = 0;
    for (const { entry } of entries) {
      for (const contribution of entry.contributions || []) {
        const usage = targetSkills.get(contribution.targetId);
        if (!usage) continue;
        const collection = contribution.channel === "usage" ? usage.usageEvents : usage.mentions;
        collection.push(hydrateEvidence(contribution.evidence));
        count += 1;
      }
    }
    return count;
  }

  function capture({ source, kind, files, baselines, targetSkills = skills }) {
    const dirtyFiles = new Set(files.map(normalizedFile));
    const contributions = new Map([...dirtyFiles].map((file) => [file, []]));

    for (const [id, usage] of targetSkills) {
      const baseline = baselines.get(id) || { usageEvents: 0, mentions: 0 };
      for (const [channel, items] of [
        ["usage", usage.usageEvents.slice(baseline.usageEvents)],
        ["mention", usage.mentions.slice(baseline.mentions)],
      ]) {
        for (const evidence of items) {
          if (!evidence.sourceFile) continue;
          const file = normalizedFile(evidence.sourceFile);
          if (!dirtyFiles.has(file)) continue;
          contributions.get(file).push({
            targetId: id,
            channel,
            evidence: serializeEvidence(evidence),
          });
        }
      }
    }

    for (const file of dirtyFiles) {
      const fingerprint = fileFingerprint(file);
      if (!fingerprint) continue;
      currentFiles[file] = {
        source,
        kind,
        fingerprint,
        contributions: contributions.get(file),
      };
    }
  }

  function commit() {
    if (!enabled) return { written: false, cacheFile };
    const modes = { ...(loaded?.modes || {}) };
    modes[mode] = { files: currentFiles };
    const document = {
      schemaVersion: SCHEMA_VERSION,
      parserVersion: PARSER_VERSION,
      inventorySignature: signature,
      modes,
    };
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    const temporary = `${cacheFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(document)}\n`, { mode: 0o600 });
      fs.renameSync(temporary, cacheFile);
      fs.chmodSync(cacheFile, 0o600);
    } catch (error) {
      try {
        fs.unlinkSync(temporary);
      } catch {}
      throw error;
    }
    return { written: true, cacheFile };
  }

  return {
    cacheFile,
    capture,
    commit,
    partitionFiles,
    replay,
    snapshot: () => snapshotEvidenceLengths(skills),
  };
}
