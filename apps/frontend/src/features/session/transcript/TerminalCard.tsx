import { asRecord, numberAt, stringAt } from "@/shared/lib/toolResult";
import { cn } from "@/shared/lib/utils";

export interface CommandRun {
  exitCode: number;
  output: string;
}

/* The runner's container exec splits the streams; the repo sandbox's Bash
   returns one combined `output`. Both reach here. */
export function parseCommandRun(result: unknown): CommandRun | null {
  const record = asRecord(result);
  if (record === null) return null;
  const exitCode = numberAt(record, "exitCode");
  if (exitCode === null) return null;
  const stdout = stringAt(record, "stdout") ?? stringAt(record, "output") ?? "";
  const stderr = stringAt(record, "stderr") ?? "";
  return {
    exitCode,
    output: [stdout, stderr].filter((s) => s.trim().length > 0).join("\n"),
  };
}

// The command is the caption and the exit code is the finding, so a failure
// reads before the output does.
export function TerminalBody({
  argv,
  run,
  maxLines,
}: {
  argv: string | null;
  run: CommandRun;
  maxLines?: number;
}): React.JSX.Element {
  const lines = run.output.split("\n");
  const shown = maxLines === undefined ? lines : lines.slice(0, maxLines);
  return (
    <div className="flex flex-col gap-2">
      {argv !== null && argv !== "" && (
        <pre className="m-0 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap">
          <span className="text-ink-subtle select-none">$ </span>
          {argv}
        </pre>
      )}
      {run.output.trim() === "" ? (
        <p className="m-0 font-mono text-sm text-ink-subtle">(no output)</p>
      ) : (
        <pre
          className={cn(
            "m-0 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap",
            run.exitCode !== 0 && "text-fail",
          )}
        >
          {shown.join("\n")}
        </pre>
      )}
    </div>
  );
}
