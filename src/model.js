import path from "node:path";
import { shellQuote } from "./fs-utils.js";
import { fileHref } from "./format.js";
import { findOmitMatch } from "./omit.js";

export function parseTimestamp(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== "string") return null;

  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;

  const match = value.match(
    /(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})[ T](?<hh>\d{2}):(?<mm>\d{2}):(?<ss>\d{2})/,
  );
  if (!match) return null;
  return new Date(
    Date.UTC(
      Number(match.groups.y),
      Number(match.groups.m) - 1,
      Number(match.groups.d),
      Number(match.groups.hh),
      Number(match.groups.mm),
      Number(match.groups.ss),
    ),
  );
}

export function timestampFromRecord(record) {
  return parseTimestamp(
    record.timestamp ??
      record.created_at ??
      record.createdAt ??
      record.created ??
      record.updated_at ??
      record.updatedAt ??
      record.started_at ??
      record.lastActivityAt ??
      record.time?.updated ??
      record.time?.created ??
      record.state?.time?.end ??
      record.state?.time?.start ??
      record.ts,
  );
}

function latest(items) {
  const dates = items.map((item) => item.ts).filter(Boolean);
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
}

function latestItem(items) {
  return items
    .filter((item) => item.ts)
    .sort((left, right) => right.ts.getTime() - left.ts.getTime())[0] || null;
}

function evidenceTitle(item) {
  if (!item) return "";
  if (item.chatTitle) return item.chatTitle;
  if (item.sourceFile) return path.parse(item.sourceFile).name || path.basename(item.sourceFile);
  return String(item.source || "").split(":")[0];
}

function recent(items, now, days) {
  return items.filter((item) => item.ts && ageDays(item.ts, now) <= days);
}

function estimateDescriptionTokens(description) {
  const text = String(description || "").trim();
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function evidenceKey(item) {
  return [
    item.kind || "",
    item.source || "",
    item.sourceFile || "",
    item.sourceLine || "",
    item.ts ? item.ts.toISOString() : "",
  ].join("\0");
}

function uniqueEvidence(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = evidenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function newestDate(dates) {
  const values = dates.filter(Boolean);
  if (values.length === 0) return null;
  return new Date(Math.max(...values.map((date) => date.getTime())));
}

function usageGroupKey(usage) {
  if (usage.fingerprint) return `${usage.skill}\0fingerprint:${usage.fingerprint}`;
  if (usage.isSymlink && usage.linkTarget) return `${usage.skill}\0symlink:${usage.linkTarget}`;
  return `${usage.skill}\0install:${usage.id || usage.path}`;
}

function groupUsages(usages) {
  const groups = new Map();
  for (const usage of usages) {
    const key = usageGroupKey(usage);
    const existing = groups.get(key);
    const install = {
      id: usage.id || usage.path,
      installRoot: usage.installRoot || "",
      path: usage.path,
      skillDir: path.dirname(usage.path),
      isSymlink: Boolean(usage.isSymlink),
      linkTarget: usage.linkTarget || "",
      fingerprint: usage.fingerprint || "",
      managedByPluginCache: Boolean(usage.managedByPluginCache),
      atime: usage.atime,
      birthtime: usage.birthtime,
      mtime: usage.mtime,
    };
    if (!existing) {
      groups.set(key, {
        ...usage,
        id: key,
        installRoot: install.installRoot,
        path: install.path,
        isSymlink: install.isSymlink,
        linkTarget: install.linkTarget,
        fingerprint: install.fingerprint,
        managedByPluginCache: install.managedByPluginCache,
        installs: [install],
        usageEvents: uniqueEvidence(usage.usageEvents),
        mentions: uniqueEvidence(usage.mentions),
      });
      continue;
    }

    existing.installs.push(install);
    existing.usageEvents = uniqueEvidence([...existing.usageEvents, ...usage.usageEvents]);
    existing.mentions = uniqueEvidence([...existing.mentions, ...usage.mentions]);
    existing.managedByPluginCache =
      Boolean(existing.managedByPluginCache) || Boolean(usage.managedByPluginCache);
    if (!existing.description && usage.description) existing.description = usage.description;
    existing.birthtime = newestDate(existing.installs.map((item) => item.birthtime));
    existing.mtime = newestDate(existing.installs.map((item) => item.mtime));
    existing.atime = newestDate(existing.installs.map((item) => item.atime));
  }
  return [...groups.values()];
}

function riskFor({ cleanupCandidate, cleanupReason, dotPrefixed, pluginManaged, recentMention }) {
  if (dotPrefixed || pluginManaged || recentMention) return "protected";
  if (!cleanupCandidate) return "none";
  if (cleanupReason.startsWith("no usage evidence")) return "medium";
  return "low";
}

export function formatDate(value) {
  if (!value) return "";
  return value.toISOString().replace("T", " ").slice(0, 19);
}

export function ageDays(value, now = new Date()) {
  if (!value) return null;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 86_400_000));
}

export function buildRows(skills, options) {
  const now = options.now || new Date();
  const protectMentionDays = options.protectMentionDays ?? options.protectWeakDays ?? options.unusedDays;
  const savingsDays = options.savingsDays ?? 30;
  const usageTokenWindowDays = 14;
  const usages = groupUsages([...skills.values()]);
  const latestUsageEventBySkill = new Map();
  const usageEventCountBySkill = new Map();
  for (const usage of usages) {
    usageEventCountBySkill.set(
      usage.skill,
      (usageEventCountBySkill.get(usage.skill) || 0) + usage.usageEvents.length,
    );
    const item = latestItem(usage.usageEvents);
    if (!item) continue;
    const current = latestUsageEventBySkill.get(usage.skill);
    if (!current || item.ts.getTime() > current.ts.getTime()) {
      latestUsageEventBySkill.set(usage.skill, item);
    }
  }

  return usages
    .map((usage) => {
      const directLastUsageEvidence = latestItem(usage.usageEvents);
      const relatedLastUsageEvidence = latestUsageEventBySkill.get(usage.skill);
      const lastUsageEvidence = directLastUsageEvidence || relatedLastUsageEvidence;
      const lastUsed = lastUsageEvidence?.ts || null;
      const lastDirectUse = directLastUsageEvidence?.ts || null;
      const lastMention = latest(usage.mentions);
      const lastSignal = latest([...usage.usageEvents, ...usage.mentions]);
      const recentUsageEvents = recent(usage.usageEvents, now, savingsDays);
      const recentMentions = recent(usage.mentions, now, savingsDays);
      const usageEvents14d = recent(usage.usageEvents, now, usageTokenWindowDays);
      const descriptionTokenCost = usage.disableModelInvocation
        ? 0
        : estimateDescriptionTokens(usage.description);
      const codexUsageCount = usage.usageEvents.filter((item) =>
        item.kind.startsWith("codex_"),
      ).length;
      const claudeUsageCount = usage.usageEvents.filter((item) =>
        item.kind.startsWith("claude_"),
      ).length;
      const opencodeUsageCount = usage.usageEvents.filter((item) =>
        item.kind.startsWith("opencode_"),
      ).length;
      const cursorUsageCount = usage.usageEvents.filter((item) =>
        item.kind.startsWith("cursor_"),
      ).length;
      const filesystemUsageCount = usage.usageEvents.filter((item) =>
        item.kind.startsWith("filesystem_"),
      ).length;
      const piUsageCount = usage.usageEvents.filter((item) =>
        item.kind.startsWith("pi_"),
      ).length;
      const opencodeMentionCount = usage.mentions.filter((item) =>
        item.kind.startsWith("opencode_"),
      ).length;
      const cursorMentionCount = usage.mentions.filter((item) =>
        item.kind.startsWith("cursor_"),
      ).length;
      const filesystemMentionCount = usage.mentions.filter((item) =>
        item.kind.startsWith("filesystem_"),
      ).length;
      const usageAgeDays = ageDays(lastUsed, now);
      const mentionAgeDays = ageDays(lastMention, now);
      const signalAgeDays = ageDays(lastSignal, now);
      const installedAt = usage.birthtime || usage.mtime;
      const installedAgeDays = ageDays(installedAt, now);
      const dotPrefixed = usage.skill.startsWith(".");
      const pluginManaged = Boolean(usage.managedByPluginCache);
      const recentMention =
        lastMention && mentionAgeDays !== null && mentionAgeDays <= protectMentionDays;

      let cleanupCandidate = false;
      let cleanupReason = "";
      if (lastUsed && usageAgeDays > options.unusedDays) {
        if (recentMention) {
          cleanupReason = `recent mention ${mentionAgeDays} days ago`;
        } else {
          cleanupCandidate = true;
          cleanupReason = `used ${usageAgeDays} days ago`;
        }
      } else if (
        !lastUsed &&
        !dotPrefixed &&
        installedAgeDays !== null &&
        installedAgeDays >= options.unusedInstalledDays
      ) {
        if (recentMention) {
          cleanupReason = `recent mention ${mentionAgeDays} days ago`;
        } else {
          cleanupCandidate = true;
          cleanupReason = lastMention
            ? `no usage evidence; last mention ${mentionAgeDays} days ago`
            : `never used; installed ${installedAgeDays} days ago`;
        }
      }
      if (pluginManaged) {
        cleanupCandidate = false;
        cleanupReason = "managed by plugin cache";
      }

      const row = {
        id: usage.id || usage.path,
        skill: usage.skill,
        install_root: usage.installRoot || "",
        path: usage.path,
        skill_dir: path.dirname(usage.path),
        install_count: usage.installs.length,
        installs: usage.installs,
        paths: usage.installs.map((item) => item.path),
        skill_dirs: usage.installs.map((item) => item.skillDir),
        managed_by_plugin_cache: pluginManaged,
        is_symlink: Boolean(usage.isSymlink),
        link_target: usage.linkTarget || "",
        description: usage.description || "",
        disable_model_invocation: Boolean(usage.disableModelInvocation),
        description_token_cost: descriptionTokenCost,
        usage_count: usage.usageEvents.length,
        mention_count: usage.mentions.length,
        usage_confidence: lastUsed ? "verified" : lastMention ? "mentioned" : "none",
        usage_scope: directLastUsageEvidence ? "direct" : lastUsageEvidence ? "same-name" : "",
        last_used: formatDate(lastUsed),
        last_direct_use: formatDate(lastDirectUse),
        last_seen: formatDate(lastSignal),
        last_usage_chat_title: evidenceTitle(lastUsageEvidence),
        last_usage_source: lastUsageEvidence?.source || "",
        last_usage_file: lastUsageEvidence?.sourceFile || "",
        last_usage_line: lastUsageEvidence?.sourceLine || "",
        last_usage_href: fileHref(lastUsageEvidence?.sourceFile),
        usage_events_14d: usageEvents14d.length,
        used_14d_tokens: descriptionTokenCost * usageEvents14d.length,
        usage_events_window: recentUsageEvents.length,
        used_window_tokens: descriptionTokenCost * recentUsageEvents.length,
        usage_window_days: savingsDays,
        codex_usage_count: codexUsageCount,
        claude_usage_count: claudeUsageCount,
        opencode_usage_count: opencodeUsageCount,
        cursor_usage_count: cursorUsageCount,
        filesystem_usage_count: filesystemUsageCount,
        pi_usage_count: piUsageCount,
        same_name_usage_count:
          (usageEventCountBySkill.get(usage.skill) || 0) - usage.usageEvents.length,
        recent_usage_count: recentUsageEvents.length,
        recent_mention_count: recentMentions.length,
        opencode_mention_count: opencodeMentionCount,
        cursor_mention_count: cursorMentionCount,
        filesystem_mention_count: filesystemMentionCount,
        usage_age_days: usageAgeDays,
        mention_age_days: mentionAgeDays,
        last_mention: formatDate(lastMention),
        verified_uses_14d: usageEvents14d.length,
        verified_uses_window: recentUsageEvents.length,
        strong_count: usage.usageEvents.length,
        same_name_verified_use_count:
          (usageEventCountBySkill.get(usage.skill) || 0) - usage.usageEvents.length,
        codex_strong_count: codexUsageCount,
        claude_strong_count: claudeUsageCount,
        opencode_strong_count: opencodeUsageCount,
        cursor_strong_count: cursorUsageCount,
        filesystem_strong_count: filesystemUsageCount,
        pi_strong_count: piUsageCount,
        last_strong_read: formatDate(lastDirectUse),
        last_direct_verified_use: formatDate(lastDirectUse),
        last_verified_use: formatDate(lastUsed),
        last_verified_scope: directLastUsageEvidence ? "direct" : lastUsageEvidence ? "same-name" : "",
        last_verified_chat_title: evidenceTitle(lastUsageEvidence),
        last_verified_source: lastUsageEvidence?.source || "",
        last_verified_file: lastUsageEvidence?.sourceFile || "",
        last_verified_line: lastUsageEvidence?.sourceLine || "",
        last_verified_href: fileHref(lastUsageEvidence?.sourceFile),
        strong_age_days: usageAgeDays,
        weak_path_refs: usage.mentions.length,
        verified_use_count: usage.usageEvents.length,
        path_mention_count: usage.mentions.length,
        recent_strong_count: recentUsageEvents.length,
        recent_weak_count: recentMentions.length,
        recent_signal_count: recentUsageEvents.length + recentMentions.length,
        opencode_weak_count: opencodeMentionCount,
        cursor_weak_count: cursorMentionCount,
        filesystem_weak_count: filesystemMentionCount,
        last_path_ref: formatDate(lastMention),
        weak_age_days: mentionAgeDays,
        last_signal_at: formatDate(lastSignal),
        last_any_signal: formatDate(lastSignal),
        signal_age_days: signalAgeDays,
        atime: formatDate(usage.atime),
        atime_age_days: ageDays(usage.atime, now),
        installed_at: formatDate(installedAt),
        installed_age_days: installedAgeDays,
        mtime: formatDate(usage.mtime),
        mtime_age_days: ageDays(usage.mtime, now),
        cleanup_candidate: cleanupCandidate,
        cleanup_reason: cleanupReason,
        remove_command: usage.installs
          .map((item) => `rm -rf ${shellQuote(item.skillDir)}`)
          .join(" && "),
      };
      row.risk = riskFor({
        cleanupCandidate,
        cleanupReason,
        dotPrefixed,
        pluginManaged,
        recentMention,
      });

      const omitMatch = findOmitMatch(row, options.omitPatterns);
      if (omitMatch) {
        return {
          ...row,
          risk: "protected",
          omitted: true,
          omit_pattern: omitMatch.pattern,
          omit_source: omitMatch.source,
          original_cleanup_candidate: cleanupCandidate,
          original_cleanup_reason: cleanupReason,
          cleanup_candidate: false,
          cleanup_reason: `omitted by whitelist: ${omitMatch.pattern}`,
        };
      }

      return {
        ...row,
        omitted: false,
        omit_pattern: "",
        omit_source: "",
        original_cleanup_candidate: cleanupCandidate,
        original_cleanup_reason: cleanupReason,
      };
    })
    .sort((a, b) => {
      if (a.cleanup_candidate !== b.cleanup_candidate) {
        return a.cleanup_candidate ? -1 : 1;
      }
      if (a.last_direct_use && b.last_direct_use) {
        return b.last_direct_use.localeCompare(a.last_direct_use);
      }
      if (a.last_direct_use) return -1;
      if (b.last_direct_use) return 1;
      return a.skill.localeCompare(b.skill);
    });
}

export function payloadFor(rows, options, scanStats, now = new Date()) {
  const candidates = rows.filter((row) => row.cleanup_candidate);
  const omitted = rows.filter((row) => row.omitted);
  const scanBuckets = Object.values(scanStats).filter(
    (value) => value && typeof value === "object" && "matchedLines" in value,
  );
  return {
    title: "Skill Cleanup",
    generatedAt: now.toISOString(),
    unusedDays: options.unusedDays,
    unusedInstalledDays: options.unusedInstalledDays,
    savingsDays: options.savingsDays ?? 30,
    source: options.source,
    summary: {
      total: rows.length,
      candidates: candidates.length,
      omitted: omitted.length,
      staleCandidates: candidates.filter((row) =>
        row.cleanup_reason.startsWith("used"),
      ).length,
      neverUsedCandidates: candidates.filter((row) =>
        row.cleanup_reason.startsWith("never used"),
      ).length,
      mentionOnlyCandidates: candidates.filter((row) =>
        row.cleanup_reason.startsWith("no usage evidence"),
      ).length,
      recentMentionProtected: rows.filter((row) =>
        row.cleanup_reason.startsWith("recent mention"),
      ).length,
      codexUsage: rows.reduce((sum, row) => sum + row.codex_usage_count, 0),
      claudeUsage: rows.reduce((sum, row) => sum + row.claude_usage_count, 0),
      opencodeUsage: rows.reduce((sum, row) => sum + row.opencode_usage_count, 0),
      cursorUsage: rows.reduce((sum, row) => sum + row.cursor_usage_count, 0),
      filesystemUsage: rows.reduce((sum, row) => sum + row.filesystem_usage_count, 0),
      opencodeMentions: rows.reduce((sum, row) => sum + row.opencode_mention_count, 0),
      cursorMentions: rows.reduce((sum, row) => sum + row.cursor_mention_count, 0),
      filesystemMentions: rows.reduce((sum, row) => sum + row.filesystem_mention_count, 0),
      weakOnlyCandidates: candidates.filter((row) =>
        row.cleanup_reason.startsWith("no usage evidence"),
      ).length,
      recentWeakProtected: rows.filter((row) =>
        row.cleanup_reason.startsWith("recent mention"),
      ).length,
      codexStrong: rows.reduce((sum, row) => sum + row.codex_strong_count, 0),
      claudeStrong: rows.reduce((sum, row) => sum + row.claude_strong_count, 0),
      opencodeStrong: rows.reduce((sum, row) => sum + row.opencode_strong_count, 0),
      cursorStrong: rows.reduce((sum, row) => sum + row.cursor_strong_count, 0),
      filesystemStrong: rows.reduce((sum, row) => sum + row.filesystem_strong_count, 0),
      piUsage: rows.reduce((sum, row) => sum + row.pi_usage_count, 0),
      piStrong: rows.reduce((sum, row) => sum + row.pi_strong_count, 0),
      opencodeWeak: rows.reduce((sum, row) => sum + row.opencode_weak_count, 0),
      cursorWeak: rows.reduce((sum, row) => sum + row.cursor_weak_count, 0),
      filesystemWeak: rows.reduce((sum, row) => sum + row.filesystem_weak_count, 0),
      descriptionTokenCost: rows.reduce((sum, row) => sum + row.description_token_cost, 0),
      candidateDescriptionTokenCost: candidates.reduce(
        (sum, row) => sum + row.description_token_cost,
        0,
      ),
      recentNewChats: scanStats.recentNewChats || 0,
      potentialCandidateNewChatTokens:
        candidates.reduce((sum, row) => sum + row.description_token_cost, 0) *
        (scanStats.recentNewChats || 0),
      recentActivitySignals: rows.reduce((sum, row) => sum + row.recent_signal_count, 0),
      used14dTokens: rows.reduce((sum, row) => sum + row.used_14d_tokens, 0),
      usedWindowTokens: rows.reduce((sum, row) => sum + row.used_window_tokens, 0),
      scanMs: scanStats.elapsedMs,
      matchedLines: scanBuckets.reduce((sum, bucket) => sum + bucket.matchedLines, 0),
      parsedRecords: scanBuckets.reduce((sum, bucket) => sum + bucket.parsedRecords, 0),
    },
    scan: scanStats,
    rows,
  };
}
