import { createInterface } from "node:readline/promises";
import pc from "picocolors";

export type UiStatus =
  | "success"
  | "info"
  | "create"
  | "update"
  | "warning"
  | "error";

export interface UiRow {
  status?: UiStatus;
  label: string;
  detail: string;
}

export interface UiError {
  code: string;
  message: string;
  path?: string;
  hint?: string;
}

export interface CliUiOptions {
  writeStdout?: (message: string) => void;
  writeStderr?: (message: string) => void;
  stdoutIsTTY?: boolean;
  stderrIsTTY?: boolean;
  color?: boolean;
  env?: NodeJS.ProcessEnv;
}

const STATUS_META: Record<
  UiStatus,
  {
    symbol: string;
    color: keyof Pick<typeof pc, "green" | "cyan" | "yellow" | "red">;
  }
> = {
  success: { symbol: "✓", color: "green" },
  info: { symbol: "•", color: "cyan" },
  create: { symbol: "+", color: "cyan" },
  update: { symbol: "~", color: "yellow" },
  warning: { symbol: "!", color: "yellow" },
  error: { symbol: "×", color: "red" },
};

function supportsColor(
  isTTY: boolean,
  env: NodeJS.ProcessEnv,
  override?: boolean,
): boolean {
  if (override !== undefined) return override;
  return isTTY && !("NO_COLOR" in env) && env.TERM !== "dumb";
}

export function createCliUi(options: CliUiOptions = {}) {
  const env = options.env ?? process.env;
  const writeStdout =
    options.writeStdout ?? ((message: string) => process.stdout.write(message));
  const writeStderr =
    options.writeStderr ?? ((message: string) => process.stderr.write(message));
  const stdoutColors = pc.createColors(
    supportsColor(
      options.stdoutIsTTY ?? Boolean(process.stdout.isTTY),
      env,
      options.color,
    ),
  );
  const stderrColors = pc.createColors(
    supportsColor(
      options.stderrIsTTY ?? Boolean(process.stderr.isTTY),
      env,
      options.color,
    ),
  );

  function statusLine(
    status: UiStatus,
    message: string,
    write: (message: string) => void,
    colors: typeof stdoutColors,
  ): void {
    const meta = STATUS_META[status];
    write(`${colors[meta.color](meta.symbol)} ${message}\n`);
  }

  return {
    success(message: string): void {
      statusLine("success", message, writeStdout, stdoutColors);
    },
    info(message: string): void {
      statusLine("info", message, writeStdout, stdoutColors);
    },
    created(message: string): void {
      statusLine("create", message, writeStdout, stdoutColors);
    },
    updated(message: string): void {
      statusLine("update", message, writeStdout, stdoutColors);
    },
    warning(message: string): void {
      statusLine("warning", message, writeStdout, stdoutColors);
    },
    error(error: UiError): void {
      const location = error.path ? `${error.path}: ` : "";
      statusLine(
        "error",
        `[${error.code}] ${location}${error.message}`,
        writeStderr,
        stderrColors,
      );
      if (error.hint) {
        writeStderr(`  ${stderrColors.cyan("→")} Fix: ${error.hint}\n`);
      }
    },
    rows(rows: UiRow[]): void {
      if (rows.length === 0) return;
      const labelWidth = Math.max(...rows.map((row) => row.label.length));
      for (const row of rows) {
        const meta = STATUS_META[row.status ?? "info"];
        const symbol = stdoutColors[meta.color](meta.symbol);
        const label = row.label.padEnd(labelWidth);
        writeStdout(`  ${symbol} ${label}  ${stdoutColors.dim(row.detail)}\n`);
      }
    },
    section(title: string): void {
      writeStdout(`${stdoutColors.bold(title)}\n`);
    },
    summary(message: string): void {
      writeStdout(`${stdoutColors.dim(message)}\n`);
    },
    hint(message: string): void {
      writeStdout(`${stdoutColors.cyan("→")} ${message}\n`);
    },
    blank(): void {
      writeStdout("\n");
    },
    question(message: string): string {
      return `${stdoutColors.cyan("?")} ${message} ${stdoutColors.dim("[y/N]")} `;
    },
    async confirm(message: string): Promise<boolean> {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await prompt.question(
          `${stdoutColors.cyan("?")} ${message} ${stdoutColors.dim("[y/N]")} `,
        );
        return ["y", "yes"].includes(answer.trim().toLowerCase());
      } finally {
        prompt.close();
      }
    },
    json(value: unknown, pretty = false): void {
      writeStdout(`${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`);
    },
  };
}

export type CliUi = ReturnType<typeof createCliUi>;

export const ui = createCliUi();
