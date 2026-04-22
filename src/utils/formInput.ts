/**
 * Unified interactive prompt component with arrow-key navigation.
 */

import { pc, lightPurple } from "./colors";
import { trackLine } from "./logger";

export type ConsultResult =
  | { action: "approve" }
  | { action: "dismiss" }
  | { action: "text"; value: string };

export type ConsultType = "plan_approval" | "missing_context" | "escalation";

type FormOption = {
  action: "approve" | "dismiss";
  label: string;
  description: string;
} | {
  action: "text";
  label: string;
  placeholder: string;
};

type FormDef = { options: FormOption[] };

const FORMS: Record<ConsultType, FormDef> = {
  plan_approval: {
    options: [
      { action: "approve", label: "Approve", description: "Execute the remediation plan" },
      { action: "dismiss", label: "Dismiss", description: "Stop working on this incident" },
      { action: "text", label: "Provide feedback", placeholder: "Describe what should change in the plan" },
    ],
  },
  missing_context: {
    options: [
      { action: "dismiss", label: "Dismiss", description: "Stop working on this incident" },
      { action: "text", label: "Answer", placeholder: "Type your answer" },
    ],
  },
  escalation: {
    options: [
      { action: "dismiss", label: "Dismiss", description: "Stop working on this incident" },
      { action: "text", label: "Provide context", placeholder: "Describe what might help the agent" },
    ],
  },
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

export function showPrompt(type: ConsultType): Promise<ConsultResult> {
  const form = FORMS[type];
  const optionCount = form.options.length;

  let selected = 0;
  let textBuffer = "";
  let totalLinesDrawn = 0;
  let cursorOffset = 0; // lines above bottom where cursor sits after render

  function isTextOption(opt: FormOption): opt is FormOption & { action: "text"; placeholder: string } {
    return opt.action === "text";
  }

  function render(): void {
    // Move cursor back to bottom before clearing (undo previous text-input repositioning)
    if (cursorOffset > 0) {
      process.stdout.write(`\x1b[${cursorOffset}B`);
      cursorOffset = 0;
    }

    // Clear previously drawn lines
    if (totalLinesDrawn > 0) {
      process.stdout.write(`\x1b[${totalLinesDrawn}A`);
      for (let i = 0; i < totalLinesDrawn; i++) {
        process.stdout.write(`\x1b[2K\n`);
      }
      process.stdout.write(`\x1b[${totalLinesDrawn}A`);
    }

    let lines = 0;
    let textInputLine = -1;
    for (let i = 0; i < optionCount; i++) {
      const opt = form.options[i];
      const active = i === selected;
      const num = `${i + 1}.`;

      if (active) {
        const arrow = lightPurple(">");
        const label = lightPurple(`${num} ${opt.label}`);
        process.stdout.write(`${arrow} ${label}\n`);
      } else {
        process.stdout.write(`  ${pc.white(num)} ${pc.white(opt.label)}\n`);
      }
      lines++;

      if (isTextOption(opt)) {
        // Text input line
        const indent = "     ";
        if (active) {
          textInputLine = lines;
          const display = textBuffer || pc.gray(opt.placeholder);
          process.stdout.write(`${indent}${display}\n`);
        } else {
          process.stdout.write(`${indent}${pc.gray(opt.placeholder)}\n`);
        }
        lines++;
      } else {
        // Description line
        process.stdout.write(`     ${pc.gray(opt.description)}\n`);
        lines++;
      }
    }

    totalLinesDrawn = lines;

    // Show blinking cursor on the text input line, hide otherwise
    const currentOpt = form.options[selected];
    if (isTextOption(currentOpt) && textInputLine >= 0) {
      const linesUp = lines - textInputLine;
      if (linesUp > 0) {
        process.stdout.write(`\x1b[${linesUp}A`);
        cursorOffset = linesUp;
      }
      const col = 5 + textBuffer.length; // 5 = indent width
      process.stdout.write(`\r\x1b[${col}C`);
      process.stdout.write(SHOW_CURSOR);
    } else {
      process.stdout.write(HIDE_CURSOR);
    }
  }

  return new Promise<ConsultResult>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    stdin.setRawMode(true);
    stdin.resume();
    process.stdout.write(HIDE_CURSOR);

    render();

    function cleanup(): void {
      stdin.removeListener("data", onData);
      stdin.setRawMode(wasRaw ?? false);
      stdin.pause();
      // Move cursor back to bottom of form before resuming normal output
      if (cursorOffset > 0) {
        process.stdout.write(`\x1b[${cursorOffset}B`);
        cursorOffset = 0;
      }
      process.stdout.write(`\r`);
      process.stdout.write(SHOW_CURSOR);
      process.stdout.write("\n");
      trackLine(totalLinesDrawn + 1);
    }

    function finish(result: ConsultResult): void {
      cleanup();
      resolve(result);
    }

    function onData(buf: Buffer): void {
      const key = buf.toString("utf-8");

      // Ctrl+C
      if (key === "\x03") {
        cleanup();
        process.exit(0);
      }

      // Arrow up
      if (key === "\x1b[A") {
        selected = (selected - 1 + optionCount) % optionCount;
        render();
        return;
      }

      // Arrow down
      if (key === "\x1b[B") {
        selected = (selected + 1) % optionCount;
        render();
        return;
      }

      const currentOpt = form.options[selected];

      // Enter
      if (key === "\r" || key === "\n") {
        if (isTextOption(currentOpt)) {
          if (textBuffer.trim()) {
            finish({ action: "text", value: textBuffer.trim() });
          }
          // No-op if text is empty
          return;
        }
        finish({ action: currentOpt.action });
        return;
      }

      // Backspace
      if (key === "\x7f" || key === "\b") {
        if (isTextOption(currentOpt) && textBuffer.length > 0) {
          textBuffer = textBuffer.slice(0, -1);
          render();
        }
        return;
      }

      // Printable characters — only on text option
      if (isTextOption(currentOpt) && key.length === 1 && key >= " ") {
        textBuffer += key;
        render();
        return;
      }
    }

    stdin.on("data", onData);
  });
}
