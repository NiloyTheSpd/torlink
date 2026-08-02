export const LOGO_LINES: readonly string[] = [
  "   ╭────────────────╮   ",
  "   │   ▸  GRAB      │   ",
  "   ╰────────────────╯   ",
];

export const LOGO_WIDTH = Math.max(...LOGO_LINES.map((l) => [...l].length));

export const SPROUT_CELLS: ReadonlySet<string> = new Set(["1,5", "2,5"]);
