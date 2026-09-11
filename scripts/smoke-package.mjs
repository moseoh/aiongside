import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function installedBin(prefix, name = "aiongside") {
  if (process.platform === "win32") {
    return path.join(prefix, `${name}.cmd`);
  }
  return path.join(prefix, "bin", name);
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
    const adapter = installedBin(prefix, "aiongside-agent-adapter");
    await mkdir(runDirectory);
    const cacheRoot = path.join(temporaryRoot, "cache");
    await mkdir(path.join(cacheRoot, "aiongside"), { recursive: true });
    await writeFile(
      path.join(cacheRoot, "aiongside", "update-check.json"),
      JSON.stringify({ schema: 1, version: "0.0.0", checkedAt: Date.now() }),
    );
    const options = {
      cwd: runDirectory,
      encoding: "utf8",
      env: {
        ...nodeOnlyEnvironment(),
        XDG_CONFIG_HOME: path.join(temporaryRoot, "config"),
        XDG_CACHE_HOME: cacheRoot,
      },
      maxBuffer: 10 * 1024 * 1024,
    };
    const help = await execFileAsync(cli, ["--help"], options);
    const version = await execFileAsync(cli, ["--version"], options);
    const initialized = await execFileAsync(cli, ["init", workspace], options);
    const synced = await execFileAsync(
      cli,
      ["--root", workspace, "workspace", "upgrade"],
      options,
    );
    const context = JSON.parse(
      (
        await execFileAsync(
          cli,
          ["--root", workspace, "context", "--json"],
          options,
        )
      ).stdout,
    );
    if (
      "rules" in context ||
      !context.ok ||
      !context.instructions?.includes("Document and folder roles")
    ) {
      throw new Error(
        "Installed context must expose only managed instructions.",
      );
    }
    const layout = (await readdir(path.join(workspace, ".aiongside"))).sort();
    if (
      JSON.stringify(layout) !==
      JSON.stringify([
        "config.yaml",
        "instructions.md",
        "internal",
        "templates",
      ])
    ) {
      throw new Error(
        `Unexpected installed workspace layout: ${layout.join(", ")}`,
      );
    }
    const internal = await readdir(path.join(workspace, ".aiongside/internal"));
    if (!internal.includes("integration.json") || !internal.includes("trash")) {
      throw new Error("Installed workspace is missing internal state paths.");
    }
    const sessionStarted = await execFileWithInput(
      adapter,
      ["session-start", "--root", workspace],
      options,
      JSON.stringify({
        session_id: "package-smoke",
        source: "startup",
        cwd: workspace,
        hook_event_name: "SessionStart",
      }),
    );
    const stopped = await execFileWithInput(
      adapter,
      ["stop", "--root", workspace],
      options,
      JSON.stringify({
        session_id: "package-smoke",
        cwd: workspace,
        hook_event_name: "Stop",
      }),
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
    const installedInstructions = await readFile(
      path.join(
        npmRoot.stdout.trim(),
        "aiongside",
        "instructions",
        "aiongside.md",
      ),
      "utf8",
    );
    const guidePath = JSON.parse(
      context.instructions.match(
        /local user guide at (".*") and answer/,
      )?.[1] ?? "null",
    );
    if (
      guidePath !==
        path.join(
          npmRoot.stdout.trim(),
          "aiongside",
          "docs",
          "user-guide.md",
        ) ||
      !(await readFile(guidePath, "utf8")).includes(
        "# Working with AIongside",
      ) ||
      context.instructions.includes("## Start work")
    ) {
      throw new Error(
        "Installed context must locate the offline guide without loading its body.",
      );
    }
    if (version.stdout !== `${manifest.version}\n`) {
      throw new Error("Installed CLI version does not match package metadata.");
    }
    if (!initialized.stdout.includes("✓ Workspace initialized")) {
      throw new Error("Installed CLI initialization output is invalid.");
    }
    if (!synced.stdout.includes("Agent integration is current")) {
      throw new Error("Installed CLI workspace upgrade output is invalid.");
    }
    if (
      (await readFile(
        path.join(workspace, ".aiongside", "instructions.md"),
        "utf8",
      )) !==
      installedInstructions.replaceAll(
        "{{AIONGSIDE_USER_GUIDE_PATH}}",
        JSON.stringify(
          path.join(
            npmRoot.stdout.trim(),
            "aiongside",
            "docs",
            "user-guide.md",
          ),
        ),
      )
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
        !settings.includes("aiongside-agent-adapter session-start") ||
        !settings.includes("aiongside-agent-adapter stop")
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

    await execFileAsync(
      cli,
      ["--root", workspace, "work", "new", "Ignore fixture"],
      options,
    );
    const dependencyDirectory = path.join(
      workspace,
      "work/WORK-1/poc/node_modules/fixture",
    );
    await mkdir(dependencyDirectory, { recursive: true });
    await writeFile(
      path.join(dependencyDirectory, "README.md"),
      "[Source](src/missing.ts)\n",
    );
    let unfiltered;
    try {
      await execFileAsync(
        cli,
        ["--root", workspace, "check", "--json"],
        options,
      );
    } catch (error) {
      if (error.code !== 1) throw error;
      unfiltered = JSON.parse(error.stdout);
    }
    if (unfiltered?.issues?.[0]?.code !== "AIO-LINK-MISSING") {
      throw new Error(
        "Installed check must report the unfiltered dependency link.",
      );
    }
    await writeFile(path.join(workspace, "work/.gitignore"), "node_modules/\n");
    const filtered = JSON.parse(
      (
        await execFileAsync(
          cli,
          ["--root", workspace, "check", "--json"],
          options,
        )
      ).stdout,
    );
    if (!filtered.ok || filtered.issues.length !== 0) {
      throw new Error("Installed check must respect nested ignore rules.");
    }
    await execFileAsync(
      cli,
      ["--root", workspace, "work", "move", "WORK-1", "done"],
      options,
    );
    await writeFile(
      path.join(dependencyDirectory, "payload.bin"),
      "Ignored after completion",
    );
    await mkdir(path.join(workspace, "knowledge/scratch"));
    await writeFile(path.join(workspace, "knowledge/.gitignore"), "scratch/\n");
    await writeFile(
      path.join(workspace, "knowledge/scratch/broken.md"),
      "No key; ignored\n[Missing](missing.md)\n",
    );
    const filteredStop = await execFileWithInput(
      adapter,
      ["stop", "--root", workspace],
      options,
      JSON.stringify({
        session_id: "package-smoke",
        cwd: workspace,
        hook_event_name: "Stop",
      }),
    );
    if (filteredStop.stdout !== "{}\n") {
      throw new Error(
        "Installed Stop must ignore dependency content in seals and Knowledge scratch documents.",
      );
    }

    const sealedContent = path.join(
      workspace,
      "work/WORK-1/evidence/result.txt",
    );
    await writeFile(sealedContent, "New included result");
    const changedSeal = JSON.parse(
      (
        await execFileWithInput(
          adapter,
          ["stop", "--root", workspace],
          options,
          JSON.stringify({
            session_id: "package-smoke",
            cwd: workspace,
            hook_event_name: "Stop",
          }),
        )
      ).stdout,
    );
    if (
      changedSeal.decision !== "block" ||
      !changedSeal.reason?.includes("AIO-DONE-INVALIDATED")
    )
      throw new Error(
        "Installed Stop must still detect changes to included completion content.",
      );
    await execFileAsync(
      cli,
      [
        "--root",
        workspace,
        "work",
        "move",
        "WORK-1",
        "active",
        "--reopen-reason",
        "Review included result",
      ],
      options,
    );
    await execFileAsync(
      cli,
      ["--root", workspace, "work", "move", "WORK-1", "done"],
      options,
    );

    const workView = path.join(workspace, "views", "open.md");
    await rm(workView);
    const blocked = JSON.parse(
      (
        await execFileWithInput(
          adapter,
          ["stop", "--root", workspace],
          options,
          JSON.stringify({
            session_id: "package-smoke",
            cwd: workspace,
            hook_event_name: "Stop",
          }),
        )
      ).stdout,
    );
    const retried = JSON.parse(
      (
        await execFileWithInput(
          adapter,
          ["stop", "--root", workspace],
          options,
          JSON.stringify({
            cwd: workspace,
            session_id: "package-smoke",
            hook_event_name: "Stop",
            stop_hook_active: true,
          }),
        )
      ).stdout,
    );
    if (
      blocked.decision !== "block" ||
      !blocked.reason?.includes("AIO-STRUCTURE-VIEW")
    ) {
      throw new Error("Installed CLI Stop Hook did not block invalid state.");
    }
    if (
      retried.decision !== undefined ||
      !retried.systemMessage?.includes("AIO-STRUCTURE-VIEW")
    ) {
      throw new Error("Installed CLI Stop Hook retry output is invalid.");
    }

    await execFileAsync(cli, ["--root", workspace, "view", "sync"], options);
    const knowledgeCreated = JSON.parse(
      (
        await execFileAsync(
          cli,
          ["--root", workspace, "knowledge", "new", "policy", "--json"],
          options,
        )
      ).stdout,
    );
    if (
      knowledgeCreated.path !== "policy.md" ||
      !knowledgeCreated.postActions?.length
    ) {
      throw new Error("Installed Knowledge creation contract is invalid.");
    }
    const documentPath = path.join(workspace, "knowledge/policy.md");
    const document = await readFile(documentPath, "utf8");
    await writeFile(documentPath, `${document}\nReusable policy.\n`);
    await writeFile(
      path.join(workspace, "knowledge/index.md"),
      "[Policy](policy.md)\n",
    );
    const moved = JSON.parse(
      (
        await execFileAsync(
          cli,
          [
            "--root",
            workspace,
            "knowledge",
            "move",
            "policy",
            "--path",
            "company/policy.md",
            "--json",
          ],
          options,
        )
      ).stdout,
    );
    if (
      moved.key !== "policy" ||
      !moved.postActions?.[0]?.message?.includes("relative links")
    ) {
      throw new Error("Installed Knowledge move contract is invalid.");
    }
    const routingStop = JSON.parse(
      (
        await execFileWithInput(
          adapter,
          ["stop", "--root", workspace],
          options,
          JSON.stringify({
            session_id: "package-smoke",
            cwd: workspace,
            hook_event_name: "Stop",
          }),
        )
      ).stdout,
    );
    if (
      routingStop.decision !== "block" ||
      !routingStop.reason.includes("AIO-KNOWLEDGE-INDEX-OMISSION")
    ) {
      throw new Error(
        "Installed Stop did not report missing Knowledge routing.",
      );
    }
    await writeFile(
      path.join(workspace, "knowledge/index.md"),
      "[Company](company/)\n",
    );
    await writeFile(
      path.join(workspace, "knowledge/company/index.md"),
      "[Policy](policy.md)\n",
    );
    const diagnosed = JSON.parse(
      (
        await execFileAsync(
          cli,
          ["--root", workspace, "doctor", "--json"],
          options,
        )
      ).stdout,
    );
    if (!diagnosed.ok) throw new Error("Installed integration doctor failed.");
    const checked = await execFileAsync(
      cli,
      ["--root", workspace, "check"],
      options,
    );
    if (checked.stdout !== "✓ Check passed\n") {
      throw new Error("Installed CLI check output is invalid.");
    }
    const webArgs = ["--root", workspace, "view", "web"];
    try {
      const started = await execFileAsync(
        cli,
        [...webArgs, "--host", "localhost", "--background"],
        {
          ...options,
          timeout: 15_000,
        },
      );
      const url = /http:\/\/localhost:\d+/.exec(started.stdout)?.[0];
      if (!url)
        throw new Error("Installed Web View did not report a ready URL.");
      for (const asset of ["/", "/app.js", "/style.css"]) {
        const response = await fetch(url + asset);
        if (!response.ok || !(await response.text()).length)
          throw new Error(`Missing bundled Web asset: ${asset}`);
      }
      const works = await (await fetch(`${url}/api/works`)).json();
      if (!works.works.some((work) => work.id === "WORK-1"))
        throw new Error("Installed Web View did not list Work.");
      const overview = await fetch(
        `${url}/api/document?path=work/WORK-1/overview.md`,
      );
      if (!overview.ok)
        throw new Error("Installed Web View could not open Overview.");
      const stopped = await execFileAsync(cli, [...webArgs, "stop"], {
        ...options,
        timeout: 10_000,
      });
      if (!stopped.stdout.includes("stopped"))
        throw new Error("Installed Web View did not stop.");
    } finally {
      await execFileAsync(cli, [...webArgs, "stop"], {
        ...options,
        timeout: 10_000,
      }).catch(() => {});
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
