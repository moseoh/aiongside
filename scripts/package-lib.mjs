import { execFile } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const repositoryRoot = path.resolve(import.meta.dirname, "..");
export const cliManifestPath = path.join(
  repositoryRoot,
  "packages",
  "cli",
  "package.json",
);
export const artifactsDirectory = path.join(
  repositoryRoot,
  ".artifacts",
  "npm",
);
export const defaultStageDirectory = path.join(artifactsDirectory, "aiongside");
export const expectedPackageFiles = [
  "LICENSE",
  "README.md",
  "dist/bin.js",
  "instructions/aiongside.md",
  "package.json",
  "skills/aiongside/SKILL.md",
];
export const canonicalSkillPath = path.join(
  repositoryRoot,
  "skills",
  "aiongside",
  "SKILL.md",
);
export const canonicalInstructionsPath = path.join(
  repositoryRoot,
  "instructions",
  "aiongside.md",
);

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function requireValue(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function validateSourceManifest(manifest) {
  requireValue(
    manifest.name === "aiongside",
    "Package name must be aiongside.",
  );
  requireValue(
    typeof manifest.version === "string" &&
      semverPattern.test(manifest.version),
    "Package version must be a valid semantic version.",
  );
  requireValue(
    manifest.bin?.aiongside === "./dist/bin.js",
    "Package bin must expose ./dist/bin.js as aiongside.",
  );
  requireValue(
    manifest.engines?.node === ">=22",
    "Package Node.js engine must be >=22.",
  );
  requireValue(
    manifest.repository?.type === "git" &&
      manifest.repository?.url ===
        "git+https://github.com/moseoh/aiongside.git",
    "Package repository must identify moseoh/aiongside.",
  );
  requireValue(manifest.license === "MIT", "Package license must be MIT.");
  requireValue(manifest.type === "module", "Package type must be module.");
  requireValue(
    manifest.publishConfig?.access === "public" &&
      manifest.publishConfig?.registry === "https://registry.npmjs.org",
    "Package publishing must target the public npm registry.",
  );
}

export function createConsumerManifest(sourceManifest) {
  validateSourceManifest(sourceManifest);

  return {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    license: sourceManifest.license,
    repository: sourceManifest.repository,
    homepage: sourceManifest.homepage,
    bugs: sourceManifest.bugs,
    engines: sourceManifest.engines,
    type: sourceManifest.type,
    bin: sourceManifest.bin,
    publishConfig: sourceManifest.publishConfig,
  };
}

export async function readSourceManifest() {
  return JSON.parse(await readFile(cliManifestPath, "utf8"));
}

async function listFiles(directory, relativeDirectory = "") {
  const entries = await readdir(path.join(directory, relativeDirectory), {
    withFileTypes: true,
  });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(directory, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(
        `Package staging contains unsupported entry: ${relativePath}`,
      );
    }
  }

  return files.sort();
}

export async function validatePackageDirectory(directory) {
  const files = await listFiles(directory);
  requireValue(
    JSON.stringify(files) === JSON.stringify(expectedPackageFiles),
    `Package files must be exactly: ${expectedPackageFiles.join(", ")}. Found: ${files.join(", ")}.`,
  );

  const manifest = JSON.parse(
    await readFile(path.join(directory, "package.json"), "utf8"),
  );
  validateSourceManifest(manifest);
  requireValue(
    !JSON.stringify(manifest).includes("workspace:"),
    "Consumer package metadata must not contain workspace dependencies.",
  );
  for (const field of [
    "dependencies",
    "devDependencies",
    "scripts",
    "workspaces",
  ]) {
    requireValue(
      !(field in manifest),
      `Consumer package metadata must not contain ${field}.`,
    );
  }

  const binPath = path.join(directory, "dist", "bin.js");
  const [
    binSource,
    binMetadata,
    packagedSkill,
    canonicalSkill,
    packagedInstructions,
    canonicalInstructions,
  ] = await Promise.all([
    readFile(binPath, "utf8"),
    stat(binPath),
    readFile(path.join(directory, "skills", "aiongside", "SKILL.md"), "utf8"),
    readFile(canonicalSkillPath, "utf8"),
    readFile(path.join(directory, "instructions", "aiongside.md"), "utf8"),
    readFile(canonicalInstructionsPath, "utf8"),
  ]);
  requireValue(
    binSource.startsWith("#!/usr/bin/env node\n"),
    "Package bin must start with the Node.js shebang.",
  );
  requireValue(
    (binMetadata.mode & 0o111) !== 0,
    "Package bin must be executable.",
  );
  requireValue(
    packagedSkill === canonicalSkill,
    "Packaged Agent Skill must match the canonical source exactly.",
  );
  requireValue(
    packagedInstructions === canonicalInstructions,
    "Packaged managed instructions must match the canonical source exactly.",
  );

  return { files, manifest };
}

export function validatePackResult(result, expectedManifest) {
  const files = result.files?.map((file) => file.path).sort() ?? [];
  requireValue(
    JSON.stringify(files) === JSON.stringify(expectedPackageFiles),
    `Tarball files must be exactly: ${expectedPackageFiles.join(", ")}. Found: ${files.join(", ")}.`,
  );
  requireValue(
    result.name === expectedManifest.name &&
      result.version === expectedManifest.version,
    "Tarball identity must match package metadata.",
  );
  const bin = result.files.find((file) => file.path === "dist/bin.js");
  requireValue(
    bin && (bin.mode & 0o111) !== 0,
    "Tarball bin must be executable.",
  );
}

export async function preparePackage({
  stageDirectory = defaultStageDirectory,
} = {}) {
  const sourceManifest = await readSourceManifest();
  const consumerManifest = createConsumerManifest(sourceManifest);

  await rm(stageDirectory, { recursive: true, force: true });
  await mkdir(path.join(stageDirectory, "dist"), { recursive: true });
  await mkdir(path.join(stageDirectory, "skills", "aiongside"), {
    recursive: true,
  });
  await mkdir(path.join(stageDirectory, "instructions"), { recursive: true });
  await Promise.all([
    copyFile(
      path.join(repositoryRoot, "packages", "cli", "dist", "bin.js"),
      path.join(stageDirectory, "dist", "bin.js"),
    ),
    copyFile(
      path.join(repositoryRoot, "README.md"),
      path.join(stageDirectory, "README.md"),
    ),
    copyFile(
      path.join(repositoryRoot, "LICENSE"),
      path.join(stageDirectory, "LICENSE"),
    ),
    copyFile(
      canonicalSkillPath,
      path.join(stageDirectory, "skills", "aiongside", "SKILL.md"),
    ),
    copyFile(
      canonicalInstructionsPath,
      path.join(stageDirectory, "instructions", "aiongside.md"),
    ),
    writeFile(
      path.join(stageDirectory, "package.json"),
      `${JSON.stringify(consumerManifest, null, 2)}\n`,
      "utf8",
    ),
  ]);
  await chmod(path.join(stageDirectory, "dist", "bin.js"), 0o755);
  await validatePackageDirectory(stageDirectory);

  return stageDirectory;
}

export async function packPackage({
  outputDirectory = artifactsDirectory,
  stageDirectory = defaultStageDirectory,
} = {}) {
  await preparePackage({ stageDirectory });
  await mkdir(outputDirectory, { recursive: true });

  const existingFiles = await readdir(outputDirectory);
  await Promise.all(
    existingFiles
      .filter((file) => /^aiongside-.*\.tgz$/.test(file))
      .map((file) => unlink(path.join(outputDirectory, file))),
  );

  const { stdout } = await execFileAsync(
    "npm",
    ["pack", stageDirectory, "--pack-destination", outputDirectory, "--json"],
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  const [result] = JSON.parse(stdout);
  requireValue(result?.filename, "npm pack did not return a tarball filename.");
  const { manifest } = await validatePackageDirectory(stageDirectory);
  validatePackResult(result, manifest);

  return {
    result,
    tarballPath: path.join(outputDirectory, result.filename),
  };
}
