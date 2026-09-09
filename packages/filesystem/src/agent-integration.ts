export const AGENT_HOOK_COMMANDS = {
  sessionStart: "aiongside-agent-adapter session-start",
  stop: "aiongside-agent-adapter stop",
} as const;

export const AGENT_INSTRUCTIONS_PATH = ".aiongside/instructions.md";

export const AGENT_HOOK_PATHS = [
  ".claude/settings.json",
  ".codex/hooks.json",
] as const;

type HookTarget = (typeof AGENT_HOOK_PATHS)[number];

function managedHookEntries(target: HookTarget) {
  const rootArgument =
    target === ".claude/settings.json"
      ? ' --root "$CLAUDE_PROJECT_DIR"'
      : ' --root "$PWD"';
  return {
    SessionStart: {
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command: AGENT_HOOK_COMMANDS.sessionStart + rootArgument,
          timeout: 10,
          statusMessage: "Loading AIongside instructions",
        },
      ],
    },
    Stop: {
      hooks: [
        {
          type: "command",
          command: AGENT_HOOK_COMMANDS.stop + rootArgument,
          timeout: 30,
          statusMessage: "Checking AIongside workspace",
        },
      ],
    },
  } as const;
}

type HookEventName = "SessionStart" | "Stop";

export function mergeAgentHookSettings(
  source?: string,
  target: HookTarget = ".codex/hooks.json",
): string {
  const managed = managedHookEntries(target);
  const root = source === undefined ? {} : parseSettings(source);
  const existingHooks = root.hooks;
  if (existingHooks !== undefined && !isRecord(existingHooks)) {
    throw new Error("The hooks property must be a JSON object.");
  }

  const hooks: Record<string, unknown> = { ...(existingHooks ?? {}) };
  for (const [registeredEvent, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      throw new Error(`${registeredEvent} hooks must be a JSON array.`);
    }
    for (const entry of entries) {
      for (const eventName of Object.keys(managed) as HookEventName[]) {
        if (
          registeredEvent !== eventName &&
          entryCommands(entry).some((command) =>
            isManagedCommand(command, eventName),
          )
        ) {
          throw new Error(
            `${managedCommand(eventName)} is registered under ${registeredEvent}.`,
          );
        }
      }
    }
  }
  let changed = existingHooks === undefined;
  for (const eventName of Object.keys(managed) as HookEventName[]) {
    const command = managedCommand(eventName);
    const current = hooks[eventName];
    if (current !== undefined && !Array.isArray(current)) {
      throw new Error(`${eventName} hooks must be a JSON array.`);
    }
    const entries = current === undefined ? [] : [...current];
    const managedIndices: number[] = [];
    for (const [index, entry] of entries.entries()) {
      const commands = entryCommands(entry);
      if (commands.some((value) => isManagedCommand(value, eventName))) {
        if (!isCompatibleManagedEntry(entry, eventName)) {
          throw new Error(
            `${eventName} contains an incompatible ${command} hook entry.`,
          );
        }
        managedIndices.push(index);
      }
    }

    const canonical = managed[eventName];
    if (
      managedIndices.length === 1 &&
      deepEqual(entries[managedIndices[0] ?? -1], canonical)
    ) {
      continue;
    }

    const firstManaged = managedIndices[0];
    const nextEntries = entries.filter(
      (_entry, index) => !managedIndices.includes(index),
    );
    if (firstManaged === undefined) {
      nextEntries.push(canonical);
    } else {
      nextEntries.splice(
        Math.min(firstManaged, nextEntries.length),
        0,
        canonical,
      );
    }
    hooks[eventName] = nextEntries;
    changed = true;
  }

  if (!changed && source !== undefined) {
    return source;
  }
  return `${JSON.stringify({ ...root, hooks }, null, 2)}\n`;
}

export function agentHookSettingsAreCurrent(
  source: string,
  target: HookTarget = ".codex/hooks.json",
): boolean {
  try {
    return mergeAgentHookSettings(source, target) === source;
  } catch {
    return false;
  }
}

function parseSettings(source: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(source);
  if (!isRecord(parsed)) {
    throw new Error("Hook settings must be a JSON object.");
  }
  return parsed;
}

function managedCommand(eventName: HookEventName): string {
  return eventName === "SessionStart"
    ? AGENT_HOOK_COMMANDS.sessionStart
    : AGENT_HOOK_COMMANDS.stop;
}

function isManagedCommand(command: string, eventName: HookEventName): boolean {
  const base = managedCommand(eventName);
  return command === base || command.startsWith(`${base} `);
}

function entryCommands(entry: unknown): string[] {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return [];
  }
  return entry.hooks.flatMap((hook) =>
    isRecord(hook) && typeof hook.command === "string" ? [hook.command] : [],
  );
}

function isCompatibleManagedEntry(
  entry: unknown,
  eventName: HookEventName,
): boolean {
  if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
    return false;
  }
  if (entry.hooks.length !== 1) {
    return false;
  }
  const hook = entry.hooks[0];
  const knownCommands = [
    managedCommand(eventName),
    ...AGENT_HOOK_PATHS.map(
      (target) => managedHookEntries(target)[eventName].hooks[0].command,
    ),
  ];
  return (
    isRecord(hook) &&
    hook.type === "command" &&
    knownCommands.includes(hook.command as string)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) {
    return false;
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(left[key], right[key]),
    )
  );
}
