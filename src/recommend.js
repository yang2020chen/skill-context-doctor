import { formatNumber } from "./format.js";
import { renderLogo } from "./logo.js";

export function formatTokens(count) {
  if (count < 1000) return String(count);
  return `~${(count / 1000).toFixed(1)}K`;
}

/**
 * Evaluates a single skill fact and returns a deterministic recommendation.
 * Rules are evaluated strictly in order (1 to 11).
 *
 * @param {object} fact Itemized fact record from buildAuditReport
 * @param {number} unusedDays Number of idle days before usage is considered stale (default: 45)
 * @returns {object} Recommendation object
 */
export function evaluateSkillRecommendation(fact, unusedDays = 45) {
  const visibleTokens = fact.visibleTokens || 0;
  const isModelVisible = Boolean(fact.isModelVisible);
  const usageCount = fact.usageCount || 0;
  const lastUsed = fact.lastUsed || null;
  const installCount = fact.installCount || 1;
  const agentUsageSources = fact.agentUsageSources || [];

  const baseResult = {
    skill: fact.skill,
    visibleTokens,
    isModelVisible,
    usageCount,
    lastUsed,
    installCount,
    agentUsageSources,
  };

  // Rule 1: BROKEN
  if (fact.isBroken) {
    return {
      ...baseResult,
      action: "REVIEW",
      confidence: "high",
      reasons: ["BROKEN_INSTALLATION"],
      explanation: "Broken symlink or missing SKILL.md definition",
    };
  }

  // Rule 2: SYSTEM / INTERNAL
  if (fact.isDotPrefixed || (fact.skill && fact.skill.startsWith("."))) {
    return {
      ...baseResult,
      action: "KEEP",
      confidence: "high",
      reasons: ["SYSTEM_OR_INTERNAL"],
      explanation: "Internal or dot-prefixed skill",
    };
  }

  // Rule 3: RECENTLY USED
  if (fact.isRecent) {
    const reasons = isModelVisible
      ? ["RECENTLY_USED", "MODEL_VISIBLE"]
      : ["RECENTLY_USED"];
    const daysText =
      fact.usageAgeDays !== null && fact.usageAgeDays !== undefined
        ? `${fact.usageAgeDays}d ago`
        : "recently";
    return {
      ...baseResult,
      action: "KEEP",
      confidence: "high",
      reasons,
      explanation: `Recently verified usage (${usageCount} time${usageCount === 1 ? "" : "s"}, last used ${daysText})`,
    };
  }

  // Rule 4: CROSS-AGENT SHARED
  if (fact.isCrossAgent || agentUsageSources.length > 1) {
    const sourcesText = agentUsageSources.join(", ") || "multiple agents";
    return {
      ...baseResult,
      action: "REVIEW",
      confidence: "high",
      reasons: ["CROSS_AGENT_SHARED"],
      explanation: `Shared across multiple agents (${sourcesText})`,
    };
  }

  // Rule 5: DUPLICATE INSTALLATION
  if (fact.isDuplicate || installCount > 1) {
    return {
      ...baseResult,
      action: "REVIEW",
      confidence: "medium",
      reasons: ["DUPLICATE_INSTALLATION"],
      explanation: `Multiple installations found (${installCount} copies across roots)`,
    };
  }

  // Rule 6: VISIBLE + NEVER USED (no recent mention)
  if (isModelVisible && fact.isNeverUsed && !fact.hasRecentMention) {
    const isHighCost = visibleTokens >= 100;
    const reasons = isHighCost
      ? ["MODEL_VISIBLE", "NEVER_USED", "HIGH_CONTEXT_COST"]
      : ["MODEL_VISIBLE", "NEVER_USED"];
    return {
      ...baseResult,
      action: "HIDE",
      confidence: "high",
      reasons,
      explanation: `Visible to model but never used (occupies ~${visibleTokens} tokens)`,
    };
  }

  // Rule 7: VISIBLE + STALE + HEAVY (stale > 45d / unusedDays, visibleTokens >= 50, no recent mention)
  if (
    isModelVisible &&
    fact.isStale &&
    (fact.usageAgeDays > 45 || fact.usageAgeDays > unusedDays) &&
    visibleTokens >= 50 &&
    !fact.hasRecentMention
  ) {
    return {
      ...baseResult,
      action: "HIDE",
      confidence: "medium",
      reasons: ["MODEL_VISIBLE", "STALE_USAGE", "CONTEXT_OVERHEAD"],
      explanation: `Stale usage (${fact.usageAgeDays}d ago) with significant context cost (~${visibleTokens} tokens)`,
    };
  }

  // Rule 8: STALE USAGE
  if (fact.isStale) {
    return {
      ...baseResult,
      action: "REVIEW",
      confidence: "medium",
      reasons: ["STALE_USAGE"],
      explanation: `Not used in past ${unusedDays} days (last used ${fact.usageAgeDays}d ago)`,
    };
  }

  // Rule 9: RECENT MENTION ONLY (mentioned in sessions but lacks verified tool execution)
  if (fact.hasRecentMention && fact.isNeverUsed) {
    const mentionCount = fact.recentMentionCount || fact.mentionCount || 1;
    return {
      ...baseResult,
      action: "REVIEW",
      confidence: "medium",
      reasons: ["RECENT_MENTIONS", "NO_VERIFIED_USAGE"],
      explanation: `Recently mentioned in sessions (${mentionCount} time${mentionCount === 1 ? "" : "s"}) but lacks verified tool execution`,
    };
  }

  // Rule 10: HIDDEN + NEVER USED (no recent mention)
  if (!isModelVisible && fact.isNeverUsed && !fact.hasRecentMention) {
    return {
      ...baseResult,
      action: "REMOVE CANDIDATE",
      confidence: "medium",
      reasons: ["NEVER_USED", "ALREADY_HIDDEN"],
      explanation: "Already hidden from model invocation and has no verified usage history",
    };
  }

  // Rule 11: FALLBACK
  return {
    ...baseResult,
    action: "REVIEW",
    confidence: "low",
    reasons: ["INSUFFICIENT_EVIDENCE"],
    explanation: "Insufficient evidence to make automated recommendation",
  };
}

/**
 * Builds the comprehensive recommendation report based on audit facts.
 *
 * @param {object} auditReport Audit report produced by buildAuditReport
 * @param {object} options Command options
 * @returns {object} Recommendation report
 */
export function buildRecommendations(auditReport, options = {}) {
  const unusedDays = options.unusedDays ?? 45;
  const facts = auditReport?.skillFacts || [];
  const displaySource = options.displaySource || null;

  const recommendations = facts.map((fact) =>
    evaluateSkillRecommendation(fact, unusedDays),
  );

  recommendations.sort((a, b) => a.skill.localeCompare(b.skill));

  let keepCount = 0;
  let hideCount = 0;
  let reviewCount = 0;
  let removeCandidateCount = 0;
  let potentialVisibleTokenSavings = 0;

  for (const rec of recommendations) {
    if (rec.action === "KEEP") {
      keepCount += 1;
    } else if (rec.action === "HIDE") {
      hideCount += 1;
      potentialVisibleTokenSavings += (rec.visibleTokens || 0);
    } else if (rec.action === "REVIEW") {
      reviewCount += 1;
    } else if (rec.action === "REMOVE CANDIDATE") {
      removeCandidateCount += 1;
    }
  }

  const highestImpact = {
    hide: recommendations
      .filter((r) => r.action === "HIDE")
      .sort((a, b) => (b.visibleTokens || 0) - (a.visibleTokens || 0))
      .slice(0, 10),
    review: recommendations
      .filter((r) => r.action === "REVIEW")
      .sort((a, b) => {
        const confOrder = { high: 0, medium: 1, low: 2 };
        const confDiff = (confOrder[a.confidence] ?? 2) - (confOrder[b.confidence] ?? 2);
        if (confDiff !== 0) return confDiff;
        return (b.visibleTokens || 0) - (a.visibleTokens || 0);
      })
      .slice(0, 10),
    removeCandidate: recommendations
      .filter((r) => r.action === "REMOVE CANDIDATE")
      .sort((a, b) => a.skill.localeCompare(b.skill))
      .slice(0, 10),
  };

  const summary = {
    totalSkills: recommendations.length,
    keepCount,
    hideCount,
    reviewCount,
    removeCandidateCount,
    keep: keepCount,
    hide: hideCount,
    review: reviewCount,
    removeCandidate: removeCandidateCount,
    potentialVisibleTokenSavings,
  };

  return {
    summary,
    recommendations,
    highestImpact,
    analysisScope: "all",
    displaySource,
  };
}

/**
 * Formats recommendation report for terminal rendering.
 *
 * @param {object} report Result from buildRecommendations
 * @param {object} options Command options
 * @returns {string} Formatted text report
 */
export function formatRecommendationReport(report, options = {}) {
  const { summary, highestImpact, displaySource, analysisScope = "all" } = report;

  const lines = [
    renderLogo(),
    "",
    "Skill Context Doctor - Recommendations (v0.2.0)",
    `Analysis Scope: ${analysisScope} evidence sources${displaySource ? ` (display filter: ${displaySource})` : ""}`,
    "",
    "Summary",
    `  KEEP                  ${formatNumber(summary.keepCount)}  (Recently used or system skills)`,
    `  HIDE                  ${formatNumber(summary.hideCount)}  (Model-visible but unused or stale)`,
  ];

  if (summary.potentialVisibleTokenSavings > 0) {
    lines.push(
      `    ↳ Potential visible context savings: ${formatTokens(summary.potentialVisibleTokenSavings)} tokens (${formatNumber(summary.potentialVisibleTokenSavings)} tokens)`,
    );
  }

  lines.push(
    `  REVIEW                ${formatNumber(summary.reviewCount)}  (Broken, cross-agent, duplicate, or stale)`,
    `  REMOVE CANDIDATE      ${formatNumber(summary.removeCandidateCount)}  (Already hidden from model and never used)`,
    "",
  );

  // Highest Impact HIDE Candidates
  if (highestImpact.hide?.length > 0) {
    lines.push("Highest Impact HIDE Candidates (Reclaim Context Overhead)");
    lines.push("");
    lines.push("Skill                            Visible Tokens   Confidence   Reasons");
    lines.push("------------------------------   --------------   ----------   ----------------------------------------");
    for (const item of highestImpact.hide) {
      const name = item.skill.length > 30 ? `${item.skill.slice(0, 27)}...` : item.skill.padEnd(30);
      const tokens = String(formatNumber(item.visibleTokens)).padStart(14);
      const conf = item.confidence.padEnd(10);
      const reasons = item.reasons.join(", ");
      lines.push(`${name}   ${tokens}   ${conf}   ${reasons}`);
    }
    lines.push("");
  }

  // Items Requiring Review
  if (highestImpact.review?.length > 0) {
    lines.push("Items Requiring Human Review");
    lines.push("");
    lines.push("Skill                            Primary Reason                Explanation");
    lines.push("------------------------------   ---------------------------   ----------------------------------------");
    for (const item of highestImpact.review) {
      const name = item.skill.length > 30 ? `${item.skill.slice(0, 27)}...` : item.skill.padEnd(30);
      const reason = (item.reasons[0] || "REVIEW").padEnd(27);
      const explanation =
        item.explanation.length > 40 ? `${item.explanation.slice(0, 37)}...` : item.explanation;
      lines.push(`${name}   ${reason}   ${explanation}`);
    }
    lines.push("");
  }

  // REMOVE CANDIDATE
  if (highestImpact.removeCandidate?.length > 0) {
    lines.push("REMOVE CANDIDATE (Safe to prune - already hidden & never used)");
    lines.push("");
    lines.push("Skill                            Confidence   Explanation");
    lines.push("------------------------------   ----------   ----------------------------------------");
    for (const item of highestImpact.removeCandidate) {
      const name = item.skill.length > 30 ? `${item.skill.slice(0, 27)}...` : item.skill.padEnd(30);
      const conf = item.confidence.padEnd(10);
      const explanation =
        item.explanation.length > 40 ? `${item.explanation.slice(0, 37)}...` : item.explanation;
      lines.push(`${name}   ${conf}   ${explanation}`);
    }
    lines.push("");
  }

  lines.push("Next steps:");
  lines.push("  • Run `skill-context-doctor audit` to inspect full usage statistics and source breakdowns.");
  lines.push("  • Run `skill-context-doctor cleanup` to review or prune cleanup candidates.");
  lines.push("");

  return `${lines.join("\n")}\n`;
}
