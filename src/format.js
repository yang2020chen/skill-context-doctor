import { pathToFileURL } from "node:url";

const numberFormat = new Intl.NumberFormat("en-US");

export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? "");
  return numberFormat.format(number);
}

export function formatDateMinute(value) {
  return String(value || "-").slice(0, 16) || "-";
}

export function formatDateOnly(value) {
  return String(value || "-").slice(0, 10) || "-";
}

export function fileHref(file) {
  if (!file) return "";
  try {
    return pathToFileURL(file).href;
  } catch {
    return "";
  }
}

export function hyperlink(label, href, enabled) {
  if (!enabled || !href) return label;
  return `\x1b]8;;${href}\x1b\\${label}\x1b]8;;\x1b\\`;
}

export function shouldUseLinks(stream) {
  return Boolean(stream?.isTTY && !process.env.SKILL_CONTEXT_DOCTOR_NO_LINKS);
}
