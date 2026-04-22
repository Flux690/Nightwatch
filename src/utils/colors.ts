/**
 * Shared color utilities for Nightwatch terminal output.
 */

import pc from "picocolors";

export { pc };
export const brightWhite = (s: string) => `\x1b[97m${s}\x1b[39m`;
export const lightPurple = (s: string) =>
  `\x1b[38;2;185;151;224m${s}\x1b[39m`;
