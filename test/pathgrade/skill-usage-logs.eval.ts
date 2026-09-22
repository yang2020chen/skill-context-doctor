import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { check, createAgent, evaluate } from "@wix/pathgrade";
import { buildRows } from "../../src/model.js";
import { collectSkills, scanEvidence } from "../../src/scan.js";

const SKILL_NAME = "pathgrade-usage-marker";
const MARKER_FILE = "pathgrade-skill-used.json";
const SKILL_FIXTURE_DIR = path.join(import.meta.dirname, "skills", SKILL_NAME);
const DEBUG_ROOT = path.join(import.meta.dirname, "pathgrade-debug");

const pathgradeAgents = ["codex", "claude", "cursor"] as const;
type PathgradeAgent = (typeof pathgradeAgents)[number];

const useModes = [
  {
    id: "indirect",
    prompt: "Prove skill usage logging by creating the required marker artifact.",
  },
  {
    id: "direct",
    prompt: `Use the ${SKILL_NAME} skill to prove skill usage logging.`,
  },
  {
    id: "path-link",
    prompt:
      `Read .agents/skills/${SKILL_NAME}/SKILL.md with your read tool, then follow it to prove skill usage logging.`,
  },
] as const;
type UseMode = (typeof useModes)[number];

const scannerModesByProvider = {
  codex: [...useModes.map((mode) => mode.id), "command-name"],
  claude: [...useModes.map((mode) => mode.id), "command-name"],
  opencode: useModes.map((mode) => mode.id),
  cursor: useModes.map((mode) => mode.id),
} as const satisfies Record<string, readonly string[]>;

function logText(value: unknown) {
  return JSON.stringify(value);
}

function hasSkillLogEvidence(log: readonly unknown[], mode: UseMode) {
  return log.some((entry) => {
    const text = logText(entry);
    if (!text.includes(SKILL_NAME)) return false;
    if (text.includes('"action":"use_skill"')) return true;
    if (text.includes("SKILL.md")) return true;
    return mode.id === "indirect" && text.includes(MARKER_FILE);
  });
}

function copySkill(skillsDir: string, name = SKILL_NAME) {
  const target = path.join(skillsDir, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(SKILL_FIXTURE_DIR, target, { recursive: true });
  return path.join(target, "SKILL.md");
}

async function scanRows(root: string, source = "all") {
  const skillsDir = path.join(root, ".agents", "skills");
  const skills = collectSkills(skillsDir);
  await scanEvidence(skills, {
    skillsDir,
    skillsDirs: [skillsDir],
    codexDir: path.join(root, ".codex"),
    claudeDir: path.join(root, ".claude"),
    claudeAppDir: path.join(root, "claude-app"),
    opencodeDir: path.join(root, "opencode"),
    cursorDir: path.join(root, ".cursor", "chats"),
    evidenceDirs: [path.join(root, "evidence")],
    source,
    fullScan: false,
  });
  return buildRows(skills, {
    unusedDays: 45,
    unusedInstalledDays: 0,
    now: new Date(),
  });
}

function writeJsonl(file: string, rows: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function makeScannerFixture(provider: string, mode: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `skill-context-doctor-eval-${provider}-${mode}-`));
  const skillPath = copySkill(path.join(root, ".agents", "skills"));
  return { root, skillPath };
}

function writeProviderEvidence(provider: string, mode: string) {
  const { root, skillPath } = makeScannerFixture(provider, mode);

  if (provider === "codex") {
    const message =
      mode === "command-name"
        ? `<command-name>${SKILL_NAME}</command-name><skill-format>true</skill-format>`
        : mode === "indirect" || mode === "direct"
          ? `<skill>\n<name>${SKILL_NAME}</name>\n<path>${skillPath}</path>\n</skill>`
          : `exec\nsed -n '1,220p' ${skillPath}\nsucceeded`;
    writeJsonl(path.join(root, ".codex", "sessions", `${mode}.jsonl`), [
      { timestamp: "2026-06-10T00:00:00Z", message },
    ]);
    return root;
  }

  if (provider === "claude") {
    const record =
      mode === "command-name"
        ? {
            timestamp: "2026-06-10T00:00:00Z",
            message:
              `<command-name>${SKILL_NAME}</command-name><skill-format>true</skill-format>`,
          }
        : mode === "indirect" || mode === "direct"
        ? { timestamp: "2026-06-10T00:00:00Z", attributionSkill: SKILL_NAME }
        : {
            type: "assistant",
            timestamp: "2026-06-10T00:00:00Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "Read",
                  input: { file_path: skillPath },
                },
              ],
            },
          };
    writeJsonl(path.join(root, ".claude", "projects", `${mode}.jsonl`), [record]);
    return root;
  }

  if (provider === "opencode") {
    const record =
      mode === "indirect" || mode === "direct"
        ? {
            type: "tool",
            tool: "read",
            state: {
              status: "completed",
              input: { filePath: skillPath },
              time: { end: "2026-06-10T00:00:00Z" },
            },
          }
        : {
            type: "tool",
            tool: "rg",
            state: {
              status: "completed",
              input: { pattern: "description", path: skillPath },
              time: { end: "2026-06-10T00:00:00Z" },
            },
          };
    const file = path.join(root, "opencode", "storage", "part", mode, "part.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
    return root;
  }

  if (provider === "cursor") {
    const record =
      mode === "indirect" || mode === "direct"
        ? {
            role: "assistant",
            timestamp: "2026-06-10T00:00:00Z",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "ReadFile",
                  input: { path: skillPath },
                },
              ],
            },
          }
        : {
            role: "assistant",
            timestamp: "2026-06-10T00:00:00Z",
            message: {
              content: [
                {
                  type: "tool_use",
                  name: "rg",
                  input: { pattern: "description", path: skillPath },
                },
              ],
            },
          };
    writeJsonl(
      path.join(
        root,
        ".cursor",
        "projects",
        "fixture",
        "agent-transcripts",
        mode,
        `${mode}.jsonl`,
      ),
      [record],
    );
    return root;
  }

  throw new Error(`Unsupported provider fixture: ${provider}`);
}

async function expectProviderMode(provider: string, mode: string) {
  const root = writeProviderEvidence(provider, mode);
  try {
    const rows = await scanRows(root, provider);
    const row = rows.find((item) => item.skill === SKILL_NAME);
    expect(row, `${provider}/${mode} row`).toBeTruthy();
    expect(row?.last_used, `${provider}/${mode} usage`).toMatch(
      /^2026-06-10/,
    );
    expect(
      row?.[`${provider}_usage_count` as keyof typeof row],
      `${provider}/${mode} provider usage count`,
    ).toBeGreaterThan(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("Pathgrade skill usage logging", () => {
  for (const agentName of pathgradeAgents) {
    for (const mode of useModes) {
      it(`${agentName} records ${mode.id} skill use`, async () => {
        const debug = path.join(DEBUG_ROOT, `${agentName}-${mode.id}`);
        fs.rmSync(debug, { recursive: true, force: true });

        const agent = await createAgent({
          agent: agentName,
          ...(agentName === "codex" ? { transport: "exec" as const } : {}),
          skillDir: SKILL_FIXTURE_DIR,
          debug,
          timeout: 180,
        });

        try {
          await agent.runConversation({
            firstMessage: mode.prompt,
            maxTurns: 2,
            until: async ({ hasFile }) => hasFile(MARKER_FILE),
          });

          const result = await evaluate(agent, [
            check(`${agentName}/${mode.id} marker file was created`, ({ workspace }) => {
              const markerPath = path.join(workspace, MARKER_FILE);
              if (!fs.existsSync(markerPath)) return false;
              const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
              return marker.skill === SKILL_NAME && marker.status === "used";
            }),
            check(`${agentName}/${mode.id} log contains skill evidence`, () =>
              hasSkillLogEvidence(agent.log, mode),
            ),
          ]);

          expect(result.score).toBe(1);
        } finally {
          await agent.dispose();
        }

        const snapshotPath = path.join(debug, "run-snapshot.json");
        expect(fs.existsSync(snapshotPath)).toBe(true);
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
        expect(hasSkillLogEvidence(snapshot.log, mode)).toBe(true);
      });
    }
  }

  for (const [provider, modes] of Object.entries(scannerModesByProvider)) {
    for (const mode of modes) {
      it(`scanner verifies ${provider} ${mode} skill use evidence`, async () => {
        await expectProviderMode(provider, mode);
      });
    }
  }
});
