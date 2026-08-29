import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { stdout } = await execFileAsync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
);
const files = stdout
  .toString("utf8")
  .split("\0")
  .filter((file) => file.length > 0);
const violations = [];

for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const [index, line] of source.split("\n").entries()) {
    if (/[\uac00-\ud7a3]/.test(line)) {
      violations.push(`${file}:${index + 1}`);
    }
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Repository text must be English. Found Korean text:\n${violations.join("\n")}\n`,
  );
  process.exitCode = 1;
}
