import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { readSourceManifest, validateSourceManifest } from "./package-lib.mjs";

const execFileAsync = promisify(execFile);

export function validateReleaseTag(tag, version) {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(`Release tag must be ${expected}. Received: ${tag ?? ""}.`);
  }
}

export async function registryVersionExists(name, version) {
  try {
    await execFileAsync(
      "npm",
      ["view", `${name}@${version}`, "version", "--json"],
      {
        encoding: "utf8",
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "stderr" in error) {
      const stderr = String(error.stderr);
      if (stderr.includes("E404")) {
        return false;
      }
    }
    throw error;
  }
}

export async function verifyRelease(
  tag,
  { versionExists = registryVersionExists } = {},
) {
  const manifest = await readSourceManifest();
  validateSourceManifest(manifest);
  validateReleaseTag(tag, manifest.version);

  if (await versionExists(manifest.name, manifest.version)) {
    throw new Error(
      `${manifest.name}@${manifest.version} is already published.`,
    );
  }

  return manifest;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = await verifyRelease(process.argv[2]);
  process.stdout.write(
    `Release verified: v${manifest.version} can publish ${manifest.name}@${manifest.version}.\n`,
  );
}
