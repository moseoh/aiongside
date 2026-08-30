import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
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

export async function smokePackage(tarball) {
  if (!tarball) {
    throw new Error("A package tarball path is required.");
  }

  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "aiongside-package-smoke-"),
  );
  const prefix = path.join(temporaryRoot, "prefix");
  const workspace = path.join(temporaryRoot, "workspace");

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
    const options = {
      encoding: "utf8",
      env: nodeOnlyEnvironment(),
      maxBuffer: 10 * 1024 * 1024,
    };
    const help = await execFileAsync(cli, ["--help"], options);
    const initialized = await execFileAsync(cli, ["init", workspace], options);
    const checked = await execFileAsync(
      cli,
      ["--root", workspace, "check"],
      options,
    );

    if (!help.stdout.includes("Usage: aiongside")) {
      throw new Error("Installed CLI help output is invalid.");
    }
    if (!initialized.stdout.includes("Initialized")) {
      throw new Error("Installed CLI initialization output is invalid.");
    }
    if (checked.stdout !== "Check passed\n") {
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
