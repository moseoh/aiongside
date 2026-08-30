import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function installedBin(prefix) {
  if (process.platform === "win32") {
    return path.join(prefix, "aiongside.cmd");
  }
  return path.join(prefix, "bin", "aiongside");
}

function nodeOnlyEnvironment() {
  const environment = { ...process.env };
  delete environment.BUN_INSTALL;
  environment.PATH = [
    path.dirname(process.execPath),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ].join(path.delimiter);
  return environment;
}

function execFileWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin.end(input);
  });
}

export async function smokePackage(tarball) {
  if (!tarball) {
    throw new Error("A package tarball path is required.");
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "aiongside-package-smoke-"),
  );
  const prefix = path.join(temporaryRoot, "prefix");
  const workspace = path.join(temporaryRoot, "workspace");
  const runDirectory = path.join(temporaryRoot, "run-from-here");

  try {
    await execFileAsync(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        path.resolve(tarball),
      ],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );

    const cli = installedBin(prefix);
    await mkdir(runDirectory);
    const options = {
      cwd: runDirectory,
      encoding: "utf8",
      env: nodeOnlyEnvironment(),
      maxBuffer: 10 * 1024 * 1024,
    };
    const help = await execFileAsync(cli, ["--help"], options);
    const version = await execFileAsync(cli, ["--version"], options);
    const initialized = await execFileAsync(cli, ["init", workspace], options);
    const synced = await execFileAsync(
      cli,
      ["--root", workspace, "skill", "sync"],
      options,
    );
    const sessionStarted = await execFileWithInput(
      cli,
      ["hook", "session-start"],
      options,
      JSON.stringify({ cwd: workspace, hook_event_name: "SessionStart" }),
    );
    const stopped = await execFileWithInput(
      cli,
      ["hook", "stop"],
      options,
      JSON.stringify({ cwd: workspace, hook_event_name: "Stop" }),
    );

    if (!help.stdout.includes("Usage: aiongside")) {
      throw new Error("Installed CLI help output is invalid.");
    }
    const npmRoot = await execFileAsync(
      "npm",
      ["root", "--global", "--prefix", prefix],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    const manifest = JSON.parse(
      await readFile(
        path.join(npmRoot.stdout.trim(), "aiongside", "package.json"),
        "utf8",
      ),
    );
    const installedSkill = await readFile(
      path.join(
        npmRoot.stdout.trim(),
        "aiongside",
        "skills",
        "aiongside",
        "SKILL.md",
      ),
      "utf8",
    );
    const installedInstructions = await readFile(
      path.join(
        npmRoot.stdout.trim(),
        "aiongside",
        "instructions",
        "aiongside.md",
      ),
      "utf8",
    );
    if (version.stdout !== `${manifest.version}\n`) {
      throw new Error("Installed CLI version does not match package metadata.");
    }
    if (!initialized.stdout.includes("✓ Workspace initialized")) {
      throw new Error("Installed CLI initialization output is invalid.");
    }
    if (!synced.stdout.includes("Agent integration is current")) {
      throw new Error("Installed CLI skill sync output is invalid.");
    }
    for (const target of [
      path.join(workspace, ".agents", "skills", "aiongside", "SKILL.md"),
      path.join(workspace, ".claude", "skills", "aiongside", "SKILL.md"),
    ]) {
      if ((await readFile(target, "utf8")) !== installedSkill) {
        throw new Error(
          "Initialized Agent Skill differs from the package source.",
        );
      }
    }
    if (
      (await readFile(
        path.join(workspace, ".aiongside", "instructions.md"),
        "utf8",
      )) !== installedInstructions
    ) {
      throw new Error(
        "Initialized managed instructions differ from the package source.",
      );
    }
    for (const target of [
      path.join(workspace, ".claude", "settings.json"),
      path.join(workspace, ".codex", "hooks.json"),
    ]) {
      const settings = await readFile(target, "utf8");
      if (
        !settings.includes("aiongside hook session-start") ||
        !settings.includes("aiongside hook stop")
      ) {
        throw new Error(`Initialized Hook settings are invalid: ${target}`);
      }
    }
    const sessionOutput = JSON.parse(sessionStarted.stdout);
    if (
      sessionOutput.hookSpecificOutput?.hookEventName !== "SessionStart" ||
      !sessionOutput.hookSpecificOutput?.additionalContext?.includes(
        "AIongside managed instructions",
      )
    ) {
      throw new Error("Installed CLI SessionStart Hook output is invalid.");
    }
    if (stopped.stdout !== "{}\n") {
      throw new Error(
        "Installed CLI Stop Hook did not allow a valid workspace.",
      );
    }

    const workspaceInstructions = path.join(
      workspace,
      ".aiongside",
      "instructions.md",
    );
    await rm(workspaceInstructions);
    const blocked = JSON.parse(
      (
        await execFileWithInput(
          cli,
          ["hook", "stop"],
          options,
          JSON.stringify({ cwd: workspace, hook_event_name: "Stop" }),
        )
      ).stdout,
    );
    const retried = JSON.parse(
      (
        await execFileWithInput(
          cli,
          ["hook", "stop"],
          options,
          JSON.stringify({
            cwd: workspace,
            hook_event_name: "Stop",
            stop_hook_active: true,
          }),
        )
      ).stdout,
    );
    if (
      blocked.decision !== "block" ||
      !blocked.reason?.includes("AIO-INSTRUCTIONS-MISSING")
    ) {
      throw new Error("Installed CLI Stop Hook did not block invalid state.");
    }
    if (
      retried.decision !== undefined ||
      !retried.systemMessage?.includes("AIO-INSTRUCTIONS-MISSING")
    ) {
      throw new Error("Installed CLI Stop Hook retry output is invalid.");
    }

    await execFileAsync(cli, ["--root", workspace, "skill", "sync"], options);
    const checked = await execFileAsync(
      cli,
      ["--root", workspace, "check"],
      options,
    );
    if (checked.stdout !== "✓ Check passed\n") {
      throw new Error("Installed CLI check output is invalid.");
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await smokePackage(process.argv[2]);
  process.stdout.write(`Package smoke test passed on ${process.version}.\n`);
}
