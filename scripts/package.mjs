import path from "node:path";
import { fileURLToPath } from "node:url";
import { packPackage, preparePackage } from "./package-lib.mjs";
import { smokePackage } from "./smoke-package.mjs";

export async function runPackageCommand(command) {
  if (command === "prepare") {
    const stageDirectory = await preparePackage();
    process.stdout.write(`${path.relative(process.cwd(), stageDirectory)}\n`);
    return;
  }

  if (command === "pack") {
    const { tarballPath } = await packPackage();
    process.stdout.write(`${path.relative(process.cwd(), tarballPath)}\n`);
    return;
  }

  if (command === "check") {
    const { tarballPath } = await packPackage();
    await smokePackage(tarballPath);
    process.stdout.write(
      `Package check passed: ${path.relative(process.cwd(), tarballPath)}\n`,
    );
    return;
  }

  throw new Error(`Unknown package command: ${command ?? ""}`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await runPackageCommand(process.argv[2]);
}
