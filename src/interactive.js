import readline from "node:readline";
import { colors, shouldUseColor } from "./ansi.js";
import { formatCleanupResult } from "./cleanup-result.js";
import {
  formatDateMinute,
  formatDateOnly,
  formatNumber,
  hyperlink,
  shouldUseLinks,
} from "./format.js";
import { renderLogo } from "./logo.js";
import { appendOmitPattern } from "./omit.js";
import { deleteCandidates, quarantineCandidates } from "./quarantine.js";

function write(stream, text) {
  stream.write(text);
}

function plural(count, one, many = `${one}s`) {
  return count === 1 ? one : many;
}

function clip(value, width) {
  const text = value === null || value === undefined ? "" : String(value);
  if (width <= 1) return text.slice(0, Math.max(0, width));
  return text.length > width ? `${text.slice(0, width - 1)}.` : text.padEnd(width);
}

function compactLastUseCell(row, width, links) {
  const date = formatDateMinute(row.last_used || row.last_verified_use);
  if (date === "-") return clip(row.cleanup_reason, width);

  const prefix = row.cleanup_reason.startsWith("last verified use ")
    ? row.cleanup_reason.replace("last verified use ", "used ")
    : row.cleanup_reason;
  const title =
    (row.usage_scope || row.last_verified_scope) === "same-name"
      ? "same-name"
      : row.last_usage_chat_title || row.last_verified_chat_title || "";
  if (!title) return clip(prefix, width);

  const titleWidth = Math.max(0, width - prefix.length - 1);
  const label = clip(title, titleWidth).trimEnd();
  const visibleLength = prefix.length + 1 + label.length;
  const text = `${prefix} ${hyperlink(label, row.last_usage_href || row.last_verified_href, links)}`;
  return `${text}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function installSourceLabel(value) {
  const text = String(value || "");
  if (text.includes("/.claude/")) return "claude";
  if (text.includes("/.cursor/")) return "cursor";
  if (text.includes("/.codex/")) return "codex";
  if (text.includes("/.agents/")) return "agents";
  return text.split("/").filter(Boolean).at(-1) || "custom";
}

function installSourcesCell(row, width) {
  const installs = row.installs?.length ? row.installs : [{ installRoot: row.install_root, path: row.path }];
  const labels = [
    ...new Set(installs.map((item) => installSourceLabel(item.installRoot || item.path))),
  ];
  const installCount = row.install_count || installs.length;
  const suffix = installCount > 1 ? ` +${formatNumber(installCount)} installs` : "";
  return clip(`${labels.join(",")}${suffix}`, width);
}

function installPathsCell(row, width) {
  const paths = row.paths?.length ? row.paths : [row.path];
  return clip(paths.join(", "), width);
}

function rowSearchText(row) {
  return [
    row.skill,
    row.install_root,
    row.path,
    ...(row.paths || []),
    row.skill_dir,
    ...(row.skill_dirs || []),
    row.link_target,
    row.cleanup_reason,
    row.risk,
    String(row.description_token_cost),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

const SORT_DEFAULT_DIRECTION = new Map([
  ["tokens", "desc"],
  ["burn", "desc"],
  ["risk", "asc"],
  ["installed", "desc"],
  ["last-used", "desc"],
]);

const SORT_HOTKEYS = new Map([
  ["t", "tokens"],
  ["b", "burn"],
  ["r", "risk"],
  ["i", "installed"],
  ["u", "last-used"],
]);

const SORT_LABELS = new Map([
  ["tokens", "tokens"],
  ["risk", "risk"],
  ["installed", "installed"],
  ["last-used", "last used"],
]);

const RISK_ORDER = new Map([
  ["low", 0],
  ["medium", 1],
  ["protected", 2],
  ["none", 3],
]);

function sortLabel(sort, windowDays) {
  if (!sort) return "";
  const label = sort.key === "burn" ? `${windowDays}d burn` : SORT_LABELS.get(sort.key);
  return `${label || sort.key} ${sort.direction}`;
}

function normalizeSort(sort) {
  if (!sort || !SORT_DEFAULT_DIRECTION.has(sort.key)) return null;
  const direction = sort.direction === "asc" || sort.direction === "desc"
    ? sort.direction
    : SORT_DEFAULT_DIRECTION.get(sort.key);
  return { key: sort.key, direction };
}

function compareText(left, right) {
  return String(left || "").localeCompare(String(right || ""));
}

function compareNumber(left, right) {
  return (left || 0) - (right || 0);
}

function compareRank(left, right, ranks) {
  return (
    (ranks.get(left) ?? Number.MAX_SAFE_INTEGER) -
    (ranks.get(right) ?? Number.MAX_SAFE_INTEGER)
  );
}

function compareDateDirection(left, right, direction) {
  const hasLeft = Boolean(left);
  const hasRight = Boolean(right);
  if (!hasLeft && !hasRight) return 0;
  if (!hasLeft) return 1;
  if (!hasRight) return -1;
  return withDirection(String(left).localeCompare(String(right)), direction);
}

function withDirection(value, direction) {
  return direction === "desc" ? -value : value;
}

function sortCandidateRows(rows, state = {}) {
  const sort = normalizeSort(state.sort);
  if (!sort) return rows;

  const recentNewChats = state.recentNewChats ?? 0;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      let comparison = 0;
      if (sort.key === "tokens") {
        comparison = withDirection(
          compareNumber(left.row.description_token_cost, right.row.description_token_cost),
          sort.direction,
        );
      } else if (sort.key === "burn") {
        comparison = withDirection(
          compareNumber(
            left.row.description_token_cost * recentNewChats,
            right.row.description_token_cost * recentNewChats,
          ),
          sort.direction,
        );
      } else if (sort.key === "risk") {
        comparison = withDirection(compareRank(left.row.risk, right.row.risk, RISK_ORDER), sort.direction);
      } else if (sort.key === "installed") {
        comparison = compareDateDirection(left.row.installed_at, right.row.installed_at, sort.direction);
      } else if (sort.key === "last-used") {
        comparison = compareDateDirection(
          left.row.last_used || left.row.last_verified_use,
          right.row.last_used || right.row.last_verified_use,
          sort.direction,
        );
      }
      if (comparison !== 0) return comparison;
      const skillComparison = compareText(left.row.skill, right.row.skill);
      if (skillComparison !== 0) return skillComparison;
      return left.index - right.index;
    })
    .map(({ row }) => row);
}

function candidateRows(rows, state = {}) {
  const omitted = state.omitted || new Set();
  const search = String(state.search || "").trim().toLowerCase();
  return sortCandidateRows(
    rows.filter(
      (row) =>
        row.cleanup_candidate &&
        !omitted.has(row.skill) &&
        (!search || rowSearchText(row).includes(search)),
    ),
    state,
  );
}

function allCandidateRows(rows, state = {}) {
  const omitted = state.omitted || new Set();
  return rows.filter((row) => row.cleanup_candidate && !omitted.has(row.skill));
}

function rowKey(row) {
  return row.id || row.skill;
}

function selectedCandidateRows(rows, state = {}) {
  const selected = state.selected || new Set();
  return candidateRows(rows, state).filter((row) => selected.has(rowKey(row)));
}

function tokenImpact(picked, state = {}) {
  const removedTokens = picked.reduce((sum, row) => sum + row.description_token_cost, 0);
  const selectedRecentUsage = picked.reduce((sum, row) => sum + row.recent_usage_count, 0);
  const selectedRecentMentions = picked.reduce((sum, row) => sum + row.recent_mention_count, 0);
  const recentNewChats = state.recentNewChats ?? 0;
  return {
    removedTokens,
    recentNewChats,
    selectedRecentUsage,
    selectedRecentMentions,
    savingsDays: state.savingsDays ?? 30,
    potentialNewChatSavings: removedTokens * recentNewChats,
  };
}

export function shouldRunInteractive(options, io = {}) {
  if (
    options.noInteractive ||
    options.command === "list" ||
    options.command === "audit" ||
    options.command === "recommend" ||
    options.apply ||
    options.commands ||
    options.json ||
    options.undo
  ) {
    return false;
  }
  if (options.interactive) return true;

  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;
  return Boolean(stdin.isTTY && stdout.isTTY && !options.csv && !options.snapshot);
}

export function renderInteractiveScreen(rows, state = {}, dimensions = {}) {
  if (state.confirming) {
    return renderConfirmationScreen(rows, state, dimensions);
  }

  const color = colors(Boolean(dimensions.colors));
  const allCandidates = allCandidateRows(rows, state);
  const candidates = candidateRows(rows, state);
  const total = rows.length;
  const protectedHidden = Math.max(0, total - allCandidates.length);
  const searchHidden = Math.max(0, allCandidates.length - candidates.length);
  const selected = state.selected || new Set();
  const omitted = state.omitted || new Set();
  const cursor = Math.min(Math.max(0, state.cursor || 0), Math.max(0, candidates.length - 1));
  const height = Math.max(10, dimensions.rows || 24);
  const width = Math.max(72, dimensions.columns || 100);
  const visible = Math.max(3, height - 9);
  const start = Math.min(
    Math.max(0, cursor - Math.floor(visible / 2)),
    Math.max(0, candidates.length - visible),
  );
  const end = Math.min(candidates.length, start + visible);
  const selectedVisible = candidates.filter((row) => selected.has(rowKey(row))).length;
  const windowDays = state.savingsDays ?? rows[0]?.usage_window_days ?? 30;
  const recentNewChats = state.recentNewChats ?? 0;
  const riskWidth = 9;
  const tokenWidth = 10;
  const burnWidth = 12;
  const nameWidth = Math.min(30, Math.max(18, Math.floor(width * 0.24)));
  const lastUseWidth = Math.min(46, Math.max(24, Math.floor(width * 0.34)));
  const installedWidth = 12;
  const sourcesWidth = Math.max(
    14,
    width -
      nameWidth -
      lastUseWidth -
      installedWidth -
      riskWidth -
      tokenWidth -
      burnWidth -
      24,
  );
  const search = String(state.search || "");
  const links = Boolean(dimensions.links);
  const sort = normalizeSort(state.sort);
  const sortText = sortLabel(sort, windowDays);

  const lines = [
    renderLogo({ color: color.title }),
    color.dim("interactive cleanup"),
    color.dim(
      `${formatNumber(allCandidates.length)} cleanup candidates, ${formatNumber(selectedVisible)} selected${search ? `, ${formatNumber(candidates.length)} visible for /${search}` : ""}${omitted.size ? `, ${formatNumber(omitted.size)} omitted this run` : ""}${searchHidden ? `, ${formatNumber(searchHidden)} hidden by search` : ""}${protectedHidden ? `, ${formatNumber(protectedHidden)} protected/recent/omitted` : ""}`,
    ),
    "",
    color.header(
      `   sel ${clip("skill", nameWidth)} ${clip("tokens", tokenWidth)} ${clip(`${windowDays}d burn`, burnWidth)} ${clip("last use", lastUseWidth)} ${clip("sources", sourcesWidth)} ${clip("risk", riskWidth)} ${clip("installed", installedWidth)}`,
    ),
    color.dim(
      `   --- ${"-".repeat(nameWidth)} ${"-".repeat(tokenWidth)} ${"-".repeat(burnWidth)} ${"-".repeat(lastUseWidth)} ${"-".repeat(sourcesWidth)} ${"-".repeat(riskWidth)} ${"-".repeat(installedWidth)}`,
    ),
  ];

  if (state.searching || search) {
    lines.push(color.info(`Search: /${search}${state.searching ? "_" : ""}`));
  }
  if (sortText) {
    lines.push(color.info(`Sort: ${sortText}`));
  }

  if (candidates.length === 0) {
    lines.push("", color.good("No cleanup candidates."));
  } else {
    for (let index = start; index < end; index += 1) {
      const row = candidates[index];
      const isSelected = selected.has(rowKey(row));
      const active = index === cursor ? color.info(">") : " ";
      const mark = isSelected ? color.good("[x]") : color.dim("[ ]");
      const skill = isSelected
        ? color.good(clip(row.skill, nameWidth))
        : clip(row.skill, nameWidth);
      const burnTokens = row.description_token_cost * recentNewChats;
      lines.push(
        `${active} ${mark} ${skill} ${color.token(clip(formatNumber(row.description_token_cost), tokenWidth))} ${color.usage(clip(formatNumber(burnTokens), burnWidth), burnTokens)} ${compactLastUseCell(row, lastUseWidth, links)} ${color.dim(installSourcesCell(row, sourcesWidth))} ${color.risk(clip(row.risk, riskWidth), row.risk)} ${clip(formatDateOnly(row.installed_at), installedWidth)}`,
      );
    }
  }

  if (state.message) {
    lines.push("", color.warn(state.message));
  } else {
    lines.push("");
  }

  lines.push(
    state.confirming
      ? color.warn("Confirm: enter quarantine, esc review")
      : state.searching
        ? color.info("Search: type to filter, enter keep, esc clear, backspace delete")
        : color.dim("Keys: / search, up/down or j/k move, space/x select, a all, o omit, t/b/r/i/u sort, enter review, q quit"),
  );
  lines.push(color.dim("Use --no-interactive for the static table. Cleanup is quarantine-only and undoable."));
  lines.push(color.dim("Last use is based on usage events; paths are shown in review before cleanup."));
  lines.push(color.dim(`${windowDays}d burn is description tokens multiplied by ${formatNumber(recentNewChats)} new chats found in the last ${formatNumber(windowDays)} days.`));
  return `${lines.join("\n")}\n`;
}

export function renderInteractiveLoadingScreen(state = {}, dimensions = {}) {
  const color = colors(Boolean(dimensions.colors));
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const spinner = frames[(state.frame || 0) % frames.length];
  const phaseLabels = new Map([
    ["skills", "Finding installed skills"],
    ["codex", "Codex"],
    ["claude", "Claude"],
    ["opencode", "OpenCode"],
    ["cursor", "Cursor"],
    ["filesystem", "Additional sources"],
    ["ranking", "Ranking cleanup candidates"],
  ]);
  const elapsedSeconds = Math.floor((state.elapsedMs || 0) / 1000);
  const details = [
    !["skills", "ranking"].includes(state.phase) ? phaseLabels.get(state.phase) : "",
    state.skillCount === undefined ? "" : `${formatNumber(state.skillCount)} skills found`,
    elapsedSeconds > 0 ? `${formatNumber(elapsedSeconds)}s elapsed` : "",
  ].filter(Boolean).join(" · ");
  const status = ["skills", "ranking"].includes(state.phase)
    ? phaseLabels.get(state.phase)
    : "Scanning agent history";
  const lines = [
    renderLogo({ color: color.title }),
    "",
    color.info(`${spinner} ${status || "Scanning skill usage"}`),
    details ? color.dim(details) : "",
    color.dim("First scan may take 1–3 minutes. Later scans only process changed history."),
  ];
  if (elapsedSeconds >= 10) lines.push(color.dim("Press Ctrl+C to stop."));
  return `${lines.join("\n")}\n`;
}

export function startInteractiveLoading(options, io = {}) {
  if (!shouldRunInteractive(options, io)) return null;

  const stdout = io.stdout || process.stdout;
  const state = { frame: 0, phase: "skills", startedAt: Date.now() };

  function renderLoading() {
    write(stdout, "\x1b[2J\x1b[H");
    write(
      stdout,
      renderInteractiveLoadingScreen(
        { ...state, elapsedMs: Date.now() - state.startedAt },
        {
          colors: shouldUseColor(stdout),
        },
      ),
    );
    state.frame += 1;
  }

  renderLoading();
  const timer = setInterval(renderLoading, 160);
  return {
    update(nextState) {
      Object.assign(state, nextState);
      renderLoading();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

function renderConfirmationScreen(rows, state = {}, dimensions = {}) {
  const color = colors(Boolean(dimensions.colors));
  const picked = selectedCandidateRows(rows, state);
  const deleteMode = Boolean(state.deleteMode);
  const height = Math.max(10, dimensions.rows || 24);
  const width = Math.max(72, dimensions.columns || 100);
  const visibleSkills = Math.max(1, Math.floor((height - 15) / 2));
  const shown = picked.slice(0, visibleSkills);
  const hidden = Math.max(0, picked.length - shown.length);
  const impact = tokenImpact(picked, state);
  const skillWidth = Math.max(24, Math.min(48, Math.floor(width * 0.4)));
  const reasonWidth = Math.max(20, width - skillWidth - 28);
  const pathWidth = Math.max(24, width - 10);

  const lines = [
    color.warn(deleteMode ? "skill-context-doctor confirm permanent delete" : "skill-context-doctor confirm cleanup"),
    "",
    deleteMode
      ? color.danger(`You are going to permanently delete ${formatNumber(picked.length)} ${plural(picked.length, "skill")} from active use.`)
      : color.danger(`You are going to remove ${formatNumber(picked.length)} ${plural(picked.length, "skill")} from active use and move them to quarantine.`),
    deleteMode
      ? color.danger("This does not write an undo manifest.")
      : color.dim("This is undoable with skill-context-doctor --undo."),
    "",
    color.header("Selected skills:"),
  ];

  if (picked.length === 0) {
    lines.push(color.good("  No selected cleanup candidates."));
  } else {
    for (const row of shown) {
      const installs = row.install_count > 1 ? ` ${formatNumber(row.install_count)} installs` : "";
      lines.push(
        `  - ${color.good(clip(row.skill, skillWidth))} ${color.token(clip(`${formatNumber(row.description_token_cost)} tokens${installs}`, 28))} ${clip(row.cleanup_reason, reasonWidth)}`,
      );
      lines.push(`    paths: ${color.dim(installPathsCell(row, pathWidth))}`);
    }
    if (hidden) lines.push(color.dim(`  ... and ${formatNumber(hidden)} more`));
  }

  lines.push(
    "",
    color.header("Estimated impact:"),
    `  ${color.token(formatNumber(impact.removedTokens))} ${plural(impact.removedTokens, "token")} saved per new conversation`,
    `  ${color.info(formatNumber(impact.recentNewChats))} ${plural(impact.recentNewChats, "conversation")} in the last ${formatNumber(impact.savingsDays)} days`,
    impact.savingsDays === 30
      ? `  ${color.good(`≈ ${formatNumber(impact.potentialNewChatSavings)} tokens saved per month`)}`
      : `  ${color.good(`≈ ${formatNumber(impact.potentialNewChatSavings)} tokens saved in this ${formatNumber(impact.savingsDays)}-day window`)}`,
    "",
    color.header("Recent activity:"),
    `  Uses       ${impact.selectedRecentUsage ? color.info(formatNumber(impact.selectedRecentUsage)) : color.dim("None")}`,
    `  Mentions   ${impact.selectedRecentMentions ? color.info(formatNumber(impact.selectedRecentMentions)) : color.dim("None")}`,
    "",
    deleteMode
      ? `${color.danger("Type DELETE then press Enter to permanently delete.")} ${color.dim("Press Esc to return to review.")}`
      : `${color.good("Press Enter to quarantine.")} ${color.warn("Press d for permanent delete.")} ${color.dim("Press Esc to return to review.")}`,
    deleteMode ? `  DELETE confirmation: ${color.warn(state.deleteConfirm || "")}` : "",
    state.message ? color.warn(state.message) : "",
    deleteMode
      ? color.danger("Confirm: type DELETE, enter delete, esc review")
      : color.warn("Confirm: enter quarantine, d delete permanently, esc review"),
  );
  return `${lines.join("\n")}\n`;
}

function render(stdout, rows, state) {
  write(stdout, "\x1b[2J\x1b[H");
  write(
    stdout,
    renderInteractiveScreen(rows, state, {
      columns: stdout.columns,
      rows: stdout.rows,
      colors: shouldUseColor(stdout),
      links: shouldUseLinks(stdout),
    }),
  );
}

function printResult(stdout, result, options) {
  write(
    stdout,
    formatCleanupResult(result, {
      stdout,
      savingsDays: options.savingsDays,
      recentNewChats: options.recentNewChats,
    }),
  );
}

export async function runInteractive(rows, payload, options, io = {}) {
  const stdin = io.stdin || process.stdin;
  const stdout = io.stdout || process.stdout;

  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    if (options.interactive) {
      throw new Error("Interactive mode requires a TTY. Use --no-interactive for static output.");
    }
    return null;
  }

  if (candidateRows(rows).length === 0) {
    write(stdout, "No cleanup candidates.\n");
    return { payload, interactive: true, cleanup: { count: 0, manifest: "", entries: [] } };
  }

  const state = {
    cursor: 0,
    selected: new Set(),
    omitted: new Set(),
    confirming: false,
    searching: false,
    search: "",
    deleteMode: false,
    deleteConfirm: "",
    sort: null,
    recentNewChats: payload.summary.recentNewChats ?? options.recentNewChats ?? 0,
    savingsDays: options.savingsDays ?? 30,
    message: "",
  };
  const wasRaw = stdin.isRaw;

  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  write(stdout, "\x1b[?25l");
  render(stdout, rows, state);

  return new Promise((resolve, reject) => {
    let finished = false;

    function cleanup({ clear = true } = {}) {
      stdin.off("keypress", onKeypress);
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      write(stdout, "\x1b[?25h");
      if (clear) write(stdout, "\x1b[2J\x1b[H");
    }

    function finish(value) {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(value);
    }

    function fail(error) {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    }

    function selectedRows() {
      return selectedCandidateRows(rows, state);
    }

    function clampCursor() {
      const candidates = candidateRows(rows, state);
      state.cursor = Math.min(Math.max(0, state.cursor), Math.max(0, candidates.length - 1));
    }

    function toggleCurrent() {
      const row = candidateRows(rows, state)[state.cursor];
      if (!row) return;
      const key = rowKey(row);
      if (state.selected.has(key)) {
        state.selected.delete(key);
      } else {
        state.selected.add(key);
      }
      state.message = "";
    }

    function toggleAll() {
      const candidates = candidateRows(rows, state);
      if (candidates.length > 0 && candidates.every((row) => state.selected.has(rowKey(row)))) {
        for (const row of candidates) state.selected.delete(rowKey(row));
      } else {
        for (const row of candidates) state.selected.add(rowKey(row));
      }
      state.message = "";
    }

    function move(delta) {
      const candidates = candidateRows(rows, state);
      state.cursor = Math.min(Math.max(0, state.cursor + delta), candidates.length - 1);
      state.message = "";
    }

    function omitCurrent() {
      const candidates = candidateRows(rows, state);
      const row = candidates[state.cursor];
      if (!row) return;
      state.omitted.add(row.skill);
      state.selected.delete(rowKey(row));
      const saved = appendOmitPattern(options, row.skill);
      state.cursor = Math.min(state.cursor, Math.max(0, candidateRows(rows, state).length - 1));
      state.message = saved.saved
        ? `Omitted ${row.skill} and saved to ${options.omitFile}.`
        : `Omitted ${row.skill} for this run.`;
    }

    function toggleSort(key) {
      const current = normalizeSort(state.sort);
      const defaultDirection = SORT_DEFAULT_DIRECTION.get(key);
      const direction = current?.key === key && current.direction === defaultDirection
        ? defaultDirection === "desc" ? "asc" : "desc"
        : defaultDirection;
      state.sort = { key, direction };
      state.cursor = 0;
      state.message = "";
    }

    function quarantineSelected() {
      const picked = selectedRows();
      const result = quarantineCandidates(picked, options);
      finished = true;
      cleanup();
      printResult(stdout, result, options);
      resolve({ payload, interactive: true, cleanup: result });
    }

    function deleteSelected() {
      const picked = selectedRows();
      const result = deleteCandidates(picked, options);
      finished = true;
      cleanup();
      printResult(stdout, result, options);
      resolve({ payload, interactive: true, cleanup: result });
    }

    function onKeypress(_str, key = {}) {
      try {
        if (key.ctrl && key.name === "c") {
          finish({ payload, interactive: true, cancelled: true });
          return;
        }

        if (state.confirming) {
          if (state.deleteMode) {
            if (key.name === "n" || key.name === "escape" || key.name === "q") {
              state.confirming = false;
              state.deleteMode = false;
              state.deleteConfirm = "";
              state.message = "Cancelled.";
              render(stdout, rows, state);
              return;
            }
            if (key.name === "backspace" || key.name === "delete") {
              state.deleteConfirm = String(state.deleteConfirm || "").slice(0, -1);
              state.message = "";
              render(stdout, rows, state);
              return;
            }
            if (key.name === "return" || key.name === "enter") {
              if (String(state.deleteConfirm || "").toLowerCase() === "delete") {
                deleteSelected();
                return;
              }
              state.message = "Type DELETE to permanently delete or Esc to review.";
              render(stdout, rows, state);
              return;
            }
            if (_str && _str.length === 1 && !key.ctrl && !key.meta) {
              state.deleteConfirm = `${state.deleteConfirm || ""}${_str}`;
              state.message = "";
              render(stdout, rows, state);
              return;
            }
            state.message = "Type DELETE to permanently delete or Esc to review.";
            render(stdout, rows, state);
            return;
          }

          if (key.name === "return" || key.name === "enter" || key.name === "y") {
            quarantineSelected();
            return;
          }
          if (_str === "d" || key.name === "d") {
            state.deleteMode = true;
            state.deleteConfirm = "";
            state.message = "";
            render(stdout, rows, state);
            return;
          }
          if (key.name === "n" || key.name === "escape" || key.name === "q") {
            state.confirming = false;
            state.deleteMode = false;
            state.deleteConfirm = "";
            state.message = "Cancelled.";
            render(stdout, rows, state);
            return;
          }
          state.message = "Press Enter to quarantine, d to delete permanently, or Esc to review.";
          render(stdout, rows, state);
          return;
        }

        if (state.searching) {
          if (key.name === "escape") {
            state.search = "";
            state.searching = false;
            state.message = "Search cleared.";
            clampCursor();
          } else if (key.name === "return" || key.name === "enter") {
            state.searching = false;
            state.message = "";
          } else if (key.name === "backspace" || key.name === "delete") {
            state.search = String(state.search || "").slice(0, -1);
            state.message = "";
            clampCursor();
          } else if (_str && _str.length === 1 && !key.ctrl && !key.meta) {
            state.search = `${state.search || ""}${_str}`;
            state.message = "";
            clampCursor();
          }
          render(stdout, rows, state);
          return;
        }

        if (key.name === "escape" && state.search) {
          state.search = "";
          state.message = "Search cleared.";
          clampCursor();
          render(stdout, rows, state);
          return;
        }

        if (key.name === "q" || key.name === "escape") {
          finish({ payload, interactive: true, cancelled: true });
          return;
        }
        if (_str === "/" || key.name === "slash") {
          state.searching = true;
          state.message = "";
        } else if (key.name === "up" || key.name === "k") move(-1);
        else if (key.name === "down" || key.name === "j") move(1);
        else if (key.name === "space" || key.name === "x") toggleCurrent();
        else if (key.name === "a") toggleAll();
        else if (key.name === "o") omitCurrent();
        else if (SORT_HOTKEYS.has(_str || key.name)) toggleSort(SORT_HOTKEYS.get(_str || key.name));
        else if (key.name === "return" || key.name === "enter") {
          if (selectedRows().length === 0) {
            state.message = "Select at least one skill first.";
          } else {
            state.confirming = true;
            state.deleteMode = false;
            state.deleteConfirm = "";
            state.message = "";
          }
        }
        render(stdout, rows, state);
      } catch (error) {
        fail(error);
      }
    }

    stdin.on("keypress", onKeypress);
  });
}
