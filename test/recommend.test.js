import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecommendations,
  evaluateSkillRecommendation,
  formatRecommendationReport,
} from "../src/recommend.js";
import { main } from "../src/app.js";

function makeRecommendFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-context-doctor-recommend-test-"));
  const skillsDirA = path.join(root, "rootA", "skills");
  const piDir = path.join(root, ".pi", "agent");
  const claudeDir = path.join(root, ".claude");
  const stateDir = path.join(root, "state");

  fs.mkdirSync(skillsDirA, { recursive: true });
  fs.mkdirSync(path.join(piDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, "projects"), { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  function addSkill(dir, name, { description = "default description", disableModel = false } = {}) {
    const skillPath = path.join(dir, name, "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    const content = [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      disableModel ? "disable-model-invocation: true" : "",
      "---",
      `# ${name}`,
    ]
      .filter(Boolean)
      .join("\n");
    fs.writeFileSync(skillPath, `${content}\n`);
    return skillPath;
  }

  return {
    root,
    skillsDirA,
    piDir,
    claudeDir,
    stateDir,
    addSkill,
  };
}

// 1. Rule 1: BROKEN
test("evaluateSkillRecommendation classifies Rule 1: BROKEN as REVIEW", () => {
  const fact = {
    skill: "broken-link",
    isBroken: true,
    isModelVisible: false,
    visibleTokens: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: true,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["BROKEN_INSTALLATION"]);
});

// 2. Rule 2: SYSTEM / INTERNAL
test("evaluateSkillRecommendation classifies Rule 2: SYSTEM / INTERNAL as KEEP", () => {
  const fact = {
    skill: ".system-helper",
    isBroken: false,
    isDotPrefixed: true,
    isModelVisible: false,
    visibleTokens: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: true,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "KEEP");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["SYSTEM_OR_INTERNAL"]);
});

// 3. Rule 3: RECENTLY USED
test("evaluateSkillRecommendation classifies Rule 3: RECENTLY USED as KEEP with MODEL_VISIBLE if visible", () => {
  const visibleFact = {
    skill: "active-tool",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 120,
    usageCount: 15,
    usageAgeDays: 3,
    isUsed: true,
    isStale: false,
    isRecent: true,
    isNeverUsed: false,
    agentUsageSources: ["pi"],
  };
  const recVisible = evaluateSkillRecommendation(visibleFact);
  assert.equal(recVisible.action, "KEEP");
  assert.equal(recVisible.confidence, "high");
  assert.deepEqual(recVisible.reasons, ["RECENTLY_USED", "MODEL_VISIBLE"]);

  const hiddenFact = {
    skill: "active-hidden-tool",
    isBroken: false,
    isModelVisible: false,
    visibleTokens: 0,
    usageCount: 5,
    usageAgeDays: 2,
    isUsed: true,
    isStale: false,
    isRecent: true,
    isNeverUsed: false,
    agentUsageSources: ["pi"],
  };
  const recHidden = evaluateSkillRecommendation(hiddenFact);
  assert.equal(recHidden.action, "KEEP");
  assert.equal(recHidden.confidence, "high");
  assert.deepEqual(recHidden.reasons, ["RECENTLY_USED"]);
});

// 4. Rule 4: CROSS-AGENT SHARED (idle, not recent)
test("evaluateSkillRecommendation classifies Rule 4: CROSS_AGENT as REVIEW", () => {
  const fact = {
    skill: "shared-util",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 30,
    usageCount: 2,
    isUsed: true,
    isStale: false,
    isRecent: false, // not recent
    isNeverUsed: false,
    isCrossAgent: true,
    agentUsageSources: ["pi", "claude"],
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["CROSS_AGENT_SHARED"]);
});

// 5. Rule 5: DUPLICATE INSTALLATION (idle, not recent, not cross-agent)
test("evaluateSkillRecommendation classifies Rule 5: DUPLICATE_INSTALLATION as REVIEW", () => {
  const fact = {
    skill: "dup-skill",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 20,
    usageCount: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: true,
    isDuplicate: true,
    installCount: 2,
    agentUsageSources: [],
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.equal(rec.confidence, "medium");
  assert.deepEqual(rec.reasons, ["DUPLICATE_INSTALLATION"]);
});

// 6. Rule 6: VISIBLE + NEVER USED
test("evaluateSkillRecommendation classifies Rule 6: VISIBLE + NEVER USED as HIDE (with HIGH_CONTEXT_COST if >= 100 tokens)", () => {
  const heavyFact = {
    skill: "heavy-unused",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 250,
    usageCount: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: true,
    hasRecentMention: false,
  };
  const recHeavy = evaluateSkillRecommendation(heavyFact);
  assert.equal(recHeavy.action, "HIDE");
  assert.equal(recHeavy.confidence, "high");
  assert.deepEqual(recHeavy.reasons, ["MODEL_VISIBLE", "NEVER_USED", "HIGH_CONTEXT_COST"]);

  const lightFact = {
    ...heavyFact,
    skill: "light-unused",
    visibleTokens: 40,
  };
  const recLight = evaluateSkillRecommendation(lightFact);
  assert.equal(recLight.action, "HIDE");
  assert.equal(recLight.confidence, "high");
  assert.deepEqual(recLight.reasons, ["MODEL_VISIBLE", "NEVER_USED"]);
});

// 7. Rule 7: VISIBLE + STALE + HEAVY
test("evaluateSkillRecommendation classifies Rule 7: VISIBLE + STALE + HEAVY as HIDE", () => {
  const fact = {
    skill: "stale-heavy-skill",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 80,
    usageCount: 3,
    usageAgeDays: 60,
    isUsed: true,
    isStale: true,
    isRecent: false,
    isNeverUsed: false,
    hasRecentMention: false,
    agentUsageSources: ["claude"],
  };
  const rec = evaluateSkillRecommendation(fact, 45);
  assert.equal(rec.action, "HIDE");
  assert.equal(rec.confidence, "medium");
  assert.deepEqual(rec.reasons, ["MODEL_VISIBLE", "STALE_USAGE", "CONTEXT_OVERHEAD"]);
});

// 8. Rule 8: STALE (general)
test("evaluateSkillRecommendation classifies Rule 8: STALE (general) as REVIEW", () => {
  const fact = {
    skill: "stale-light-skill",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 20, // < 50 tokens
    usageCount: 2,
    usageAgeDays: 50,
    isUsed: true,
    isStale: true,
    isRecent: false,
    isNeverUsed: false,
    hasRecentMention: false,
    agentUsageSources: ["codex"],
  };
  const rec = evaluateSkillRecommendation(fact, 45);
  assert.equal(rec.action, "REVIEW");
  assert.equal(rec.confidence, "medium");
  assert.deepEqual(rec.reasons, ["STALE_USAGE"]);
});

// 9. Rule 9: RECENT MENTION ONLY
test("evaluateSkillRecommendation classifies Rule 9: RECENT MENTION ONLY as REVIEW", () => {
  const fact = {
    skill: "mentioned-only",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 30,
    usageCount: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: true,
    hasRecentMention: true,
    recentMentionCount: 3,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.equal(rec.confidence, "medium");
  assert.deepEqual(rec.reasons, ["RECENT_MENTIONS", "NO_VERIFIED_USAGE"]);
});

// 10. Rule 10: HIDDEN + NEVER USED
test("evaluateSkillRecommendation classifies Rule 10: HIDDEN + NEVER USED as REMOVE CANDIDATE", () => {
  const fact = {
    skill: "hidden-unused",
    isBroken: false,
    isModelVisible: false,
    visibleTokens: 0,
    usageCount: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: true,
    hasRecentMention: false,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REMOVE CANDIDATE");
  assert.equal(rec.confidence, "medium");
  assert.deepEqual(rec.reasons, ["NEVER_USED", "ALREADY_HIDDEN"]);
});

// 11. Rule 11: FALLBACK
test("evaluateSkillRecommendation classifies Rule 11: FALLBACK as REVIEW with low confidence", () => {
  const fact = {
    skill: "mysterious-skill",
    isBroken: false,
    isModelVisible: false,
    visibleTokens: 0,
    usageCount: 0,
    isUsed: false,
    isStale: false,
    isRecent: false,
    isNeverUsed: false, // not marked neverUsed, but not used either
    hasRecentMention: false,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.equal(rec.confidence, "low");
  assert.deepEqual(rec.reasons, ["INSUFFICIENT_EVIDENCE"]);
});

// 12. Edge Case 1: BROKEN + RECENTLY_USED -> REVIEW (Rule 1 > Rule 3)
test("Edge Case 1: BROKEN + RECENTLY_USED -> REVIEW (Rule 1 has priority over Rule 3)", () => {
  const fact = {
    skill: "broken-but-used",
    isBroken: true,
    isModelVisible: false,
    visibleTokens: 0,
    usageCount: 10,
    usageAgeDays: 1,
    isUsed: true,
    isRecent: true,
    isNeverUsed: false,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.deepEqual(rec.reasons, ["BROKEN_INSTALLATION"]);
});

// 13. Edge Case 2: RECENTLY_USED + CROSS_AGENT -> KEEP (Rule 3 > Rule 4)
test("Edge Case 2: RECENTLY_USED + CROSS_AGENT -> KEEP (Rule 3 has priority over Rule 4)", () => {
  const fact = {
    skill: "popular-cross-agent-skill",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 50,
    usageCount: 40,
    usageAgeDays: 2,
    isUsed: true,
    isRecent: true,
    isNeverUsed: false,
    isCrossAgent: true,
    agentUsageSources: ["pi", "claude"],
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "KEEP");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reasons, ["RECENTLY_USED", "MODEL_VISIBLE"]);
});

// 14. Edge Case 3: HIDDEN + NEVER_USED + RECENT_MENTION -> REVIEW (Rule 9 > Rule 10)
test("Edge Case 3: HIDDEN + NEVER_USED + RECENT_MENTION -> REVIEW (Rule 9 has priority over Rule 10)", () => {
  const fact = {
    skill: "hidden-but-mentioned",
    isBroken: false,
    isModelVisible: false,
    visibleTokens: 0,
    usageCount: 0,
    isUsed: false,
    isRecent: false,
    isNeverUsed: true,
    hasRecentMention: true,
    recentMentionCount: 2,
  };
  const rec = evaluateSkillRecommendation(fact);
  assert.equal(rec.action, "REVIEW");
  assert.deepEqual(rec.reasons, ["RECENT_MENTIONS", "NO_VERIFIED_USAGE"]);
});

// 15. Edge Case 4: Skill used in Claude (20 uses) and 0 in Pi evaluated with --source pi -> KEEP
test("Edge Case 4: Skill used in Claude (20 uses) and 0 in Pi evaluated with --source pi -> KEEP", () => {
  // Facts are produced globally across all agents:
  const globalFact = {
    skill: "claude-heavy-tool",
    isBroken: false,
    isModelVisible: true,
    visibleTokens: 80,
    usageCount: 20,
    usageAgeDays: 5,
    isUsed: true,
    isRecent: true,
    isNeverUsed: false,
    agentUsageSources: ["claude"],
  };

  const auditReport = {
    skillFacts: [globalFact],
  };

  // User specifies --source pi
  const recReport = buildRecommendations(auditReport, {
    displaySource: "pi",
    unusedDays: 45,
  });

  assert.equal(recReport.analysisScope, "all");
  assert.equal(recReport.displaySource, "pi");
  assert.equal(recReport.recommendations.length, 1);

  const rec = recReport.recommendations[0];
  assert.equal(rec.action, "KEEP");
  assert.notEqual(rec.action, "REMOVE CANDIDATE");
  assert.notEqual(rec.action, "HIDE");
  assert.deepEqual(rec.reasons, ["RECENTLY_USED", "MODEL_VISIBLE"]);
});

// 16. buildRecommendations computes summary and potentialVisibleTokenSavings for HIDE only
test("buildRecommendations calculates correct summary counts and potentialVisibleTokenSavings for HIDE only", () => {
  const auditReport = {
    skillFacts: [
      {
        skill: "tool-keep",
        isBroken: false,
        isModelVisible: true,
        visibleTokens: 100,
        usageCount: 5,
        isUsed: true,
        isRecent: true,
        isNeverUsed: false,
      },
      {
        skill: "tool-hide-1",
        isBroken: false,
        isModelVisible: true,
        visibleTokens: 300,
        usageCount: 0,
        isUsed: false,
        isRecent: false,
        isNeverUsed: true,
        hasRecentMention: false,
      },
      {
        skill: "tool-hide-2",
        isBroken: false,
        isModelVisible: true,
        visibleTokens: 150,
        usageCount: 0,
        isUsed: false,
        isRecent: false,
        isNeverUsed: true,
        hasRecentMention: false,
      },
      {
        skill: "tool-remove-candidate",
        isBroken: false,
        isModelVisible: false,
        visibleTokens: 0,
        usageCount: 0,
        isUsed: false,
        isRecent: false,
        isNeverUsed: true,
        hasRecentMention: false,
      },
      {
        skill: "tool-review",
        isBroken: true,
        isModelVisible: false,
        visibleTokens: 0,
      },
    ],
  };

  const report = buildRecommendations(auditReport);
  assert.equal(report.summary.totalSkills, 5);
  assert.equal(report.summary.keepCount, 1);
  assert.equal(report.summary.hideCount, 2);
  assert.equal(report.summary.removeCandidateCount, 1);
  assert.equal(report.summary.reviewCount, 1);

  // Potential visible token savings must ONLY sum HIDE candidates (300 + 150 = 450)
  assert.equal(report.summary.potentialVisibleTokenSavings, 450);
});

// 17. buildRecommendations populates highestImpact categories sorted properly
test("buildRecommendations populates highestImpact categories sorted properly", () => {
  const auditReport = {
    skillFacts: [
      {
        skill: "b-hide",
        isModelVisible: true,
        visibleTokens: 200,
        isNeverUsed: true,
      },
      {
        skill: "a-hide",
        isModelVisible: true,
        visibleTokens: 500,
        isNeverUsed: true,
      },
      {
        skill: "c-remove",
        isModelVisible: false,
        isNeverUsed: true,
      },
    ],
  };

  const report = buildRecommendations(auditReport);
  assert.equal(report.highestImpact.hide.length, 2);
  // Highest tokens first
  assert.equal(report.highestImpact.hide[0].skill, "a-hide");
  assert.equal(report.highestImpact.hide[1].skill, "b-hide");
  assert.equal(report.highestImpact.removeCandidate.length, 1);
  assert.equal(report.highestImpact.removeCandidate[0].skill, "c-remove");
});

// 18. formatRecommendationReport renders summary banner and sections cleanly
test("formatRecommendationReport renders summary banner and sections cleanly", () => {
  const report = {
    summary: {
      totalSkills: 10,
      keepCount: 4,
      hideCount: 3,
      reviewCount: 2,
      removeCandidateCount: 1,
      potentialVisibleTokenSavings: 850,
    },
    highestImpact: {
      hide: [
        {
          skill: "unused-costly",
          visibleTokens: 500,
          confidence: "high",
          reasons: ["MODEL_VISIBLE", "NEVER_USED", "HIGH_CONTEXT_COST"],
        },
      ],
      review: [
        {
          skill: "broken-tool",
          reasons: ["BROKEN_INSTALLATION"],
          explanation: "Broken symlink or missing SKILL.md definition",
        },
      ],
      removeCandidate: [
        {
          skill: "hidden-dead",
          confidence: "medium",
          explanation: "Already hidden from model invocation and has no verified usage history",
        },
      ],
    },
    analysisScope: "all",
    displaySource: null,
  };

  const text = formatRecommendationReport(report);
  assert.match(text, /Skill Context Doctor/);
  assert.match(text, /Skill Context Doctor - Recommendations/);
  assert.match(text, /KEEP\s+4/);
  assert.match(text, /HIDE\s+3/);
  assert.match(text, /Potential visible context savings:\s+850 tokens/);
  assert.match(text, /REVIEW\s+2/);
  assert.match(text, /REMOVE CANDIDATE\s+1/);
  assert.match(text, /Highest Impact HIDE Candidates/);
  assert.match(text, /unused-costly/);
  assert.match(text, /broken-tool/);
  assert.match(text, /hidden-dead/);
});

// 19. CLI recommend --json outputs valid structured JSON payload via main CLI
test("CLI recommend --json outputs valid structured JSON payload via main CLI", async () => {
  const fixture = makeRecommendFixture();
  fixture.addSkill(fixture.skillsDirA, "demo-skill", { description: "Demo description" });

  let stdout = "";
  const result = await main(
    [
      "recommend",
      "--path",
      fixture.skillsDirA,
      "--pi-dir",
      fixture.piDir,
      "--state-dir",
      fixture.stateDir,
      "--json",
      "--no-cache",
    ],
    { stdout: { write: (chunk) => (stdout += chunk) } },
  );

  assert.ok(result);
  assert.equal(result.analysisScope, "all");
  assert.ok(result.summary);
  assert.equal(result.summary.totalSkills, 1);
  assert.equal(result.recommendations.length, 1);

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.analysisScope, "all");
  assert.equal(parsed.summary.totalSkills, 1);
  assert.ok(Array.isArray(parsed.recommendations));
  assert.ok(parsed.highestImpact);
});

// 20. recommend forbids --apply with advisory error
test("recommend command throws error if --apply is provided", async () => {
  await assert.rejects(
    async () => {
      await main(["recommend", "--apply"]);
    },
    {
      message: /recommend does not support --apply \(recommendations are advisory\)/,
    },
  );
});
