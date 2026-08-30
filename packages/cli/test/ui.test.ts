import { describe, expect, test } from "vitest";
import { createCliUi } from "../src/ui.js";

function capture(
  options: { color?: boolean; tty?: boolean; noColor?: boolean } = {},
) {
  let stdout = "";
  let stderr = "";
  const env = options.noColor ? { NO_COLOR: "1" } : {};
  const ui = createCliUi({
    writeStdout: (message) => {
      stdout += message;
    },
    writeStderr: (message) => {
      stderr += message;
    },
    stdoutIsTTY: options.tty ?? false,
    stderrIsTTY: options.tty ?? false,
    ...(options.color === undefined ? {} : { color: options.color }),
    env,
  });
  return {
    ui,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

describe("CLI UI", () => {
  test("renders semantic plain-text output and aligned rows", () => {
    const output = capture();

    output.ui.success("Workspace initialized");
    output.ui.rows([
      { label: "Root", detail: "/workspace" },
      { status: "create", label: "Agent integration", detail: "5 files" },
    ]);
    output.ui.summary("created 5");
    output.ui.hint('Create work: aiongside work new "First Work"');
    output.ui.warning("Approve project Hooks when prompted");
    output.ui.error({
      code: "AIO-EXAMPLE",
      path: "work/WORK-1/record.md",
      message: "Example failure",
      hint: "Run aiongside check",
    });

    expect(output.stdout()).toBe(
      "✓ Workspace initialized\n" +
        "  • Root               /workspace\n" +
        "  + Agent integration  5 files\n" +
        "created 5\n" +
        '→ Create work: aiongside work new "First Work"\n' +
        "! Approve project Hooks when prompted\n",
    );
    expect(output.stderr()).toBe(
      "× [AIO-EXAMPLE] work/WORK-1/record.md: Example failure\n" +
        "  → Fix: Run aiongside check\n",
    );
  });

  test("uses color only when enabled for a terminal", () => {
    const terminal = capture({ tty: true });
    terminal.ui.success("Done");
    expect(terminal.stdout()).toContain("\u001b[");

    const piped = capture({ tty: false });
    piped.ui.success("Done");
    expect(piped.stdout()).toBe("✓ Done\n");

    const disabled = capture({ tty: true, noColor: true });
    disabled.ui.success("Done");
    expect(disabled.stdout()).toBe("✓ Done\n");
  });

  test("writes JSON without human decoration", () => {
    const output = capture({ color: true });

    output.ui.json({ status: "ok" });
    output.ui.json({ status: "ok" }, true);

    expect(output.stdout()).toBe('{"status":"ok"}\n{\n  "status": "ok"\n}\n');
    expect(output.stdout()).not.toContain("\u001b[");
  });
});
