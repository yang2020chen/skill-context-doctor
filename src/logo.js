export const LOGO_LINES = [
  "Skill Context Doctor",
];

export function renderLogo({ color = (value) => value } = {}) {
  return LOGO_LINES.map((line) => color(line)).join("\n");
}
