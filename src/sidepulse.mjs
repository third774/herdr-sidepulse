import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const LEDS_FILE = "LEDS.LED";
const DISPLAY_STATES = new Set(["idle", "working", "blocked", "completed"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSequence(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizedDoneSequences(doneSequences) {
  if (!isRecord(doneSequences)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(doneSequences).filter(
      ([terminalId, sequence]) => typeof terminalId === "string" && validSequence(sequence),
    ),
  );
}

export function selectDisplay(agents, doneSequences) {
  const nextDoneSequences = normalizedDoneSequences(doneSequences);
  const doneAgents = [];
  let hasBlockedAgent = false;
  let hasWorkingAgent = false;

  for (const agent of agents) {
    if (!isRecord(agent) || typeof agent.terminal_id !== "string") {
      continue;
    }

    if (agent.agent_status === "blocked") {
      hasBlockedAgent = true;
    }
    if (agent.agent_status === "working") {
      hasWorkingAgent = true;
    }
    if (agent.agent_status === "done" && validSequence(agent.state_change_seq)) {
      doneAgents.push(agent);
    } else {
      delete nextDoneSequences[agent.terminal_id];
    }
  }

  if (hasBlockedAgent) {
    return { display: "blocked", doneSequences: nextDoneSequences };
  }
  if (hasWorkingAgent) {
    return { display: "working", doneSequences: nextDoneSequences };
  }

  const hasNewCompletion = doneAgents.some(
    (agent) => nextDoneSequences[agent.terminal_id] !== agent.state_change_seq,
  );
  if (hasNewCompletion) {
    for (const agent of doneAgents) {
      nextDoneSequences[agent.terminal_id] = agent.state_change_seq;
    }
    return { display: "completed", doneSequences: nextDoneSequences };
  }

  return { display: "idle", doneSequences: nextDoneSequences };
}

export function renderProgram(display, ledCount) {
  if (!DISPLAY_STATES.has(display)) {
    throw new Error(`Unknown SidePulse display state: ${display}`);
  }
  if (!Number.isSafeInteger(ledCount) || ledCount < 1) {
    throw new Error(`Invalid SidePulse LED count: ${ledCount}`);
  }

  switch (display) {
    case "idle":
      return "off\n#004d59 1.6s pulse\noff 500ms none\nrepeat";
    case "working":
      return [
        "off",
        ...Array.from({ length: ledCount }, (_, index) => `${index}:#00c8dd 250ms pulse`),
        "repeat",
      ].join("\n");
    case "blocked":
      return "off\n#ff8a00 350ms pulse\n#ff8a00 350ms pulse\noff 900ms none\nrepeat";
    case "completed":
      return "off\n#00c8dd 250ms pulse\n#00c8dd 250ms pulse\noff";
  }
}

function ledCountForPath(devicePath) {
  return basename(devicePath).toLowerCase() === "sidepulsedot" ? 2 : 8;
}

export async function discoverDevices(candidatePaths) {
  const candidates = [...new Set(candidatePaths.map((candidate) => resolve(candidate)))];
  const devices = [];

  for (const devicePath of candidates) {
    const programPath = join(devicePath, LEDS_FILE);
    try {
      const program = await stat(programPath);
      if (program.isFile()) {
        devices.push({
          path: devicePath,
          ledCount: ledCountForPath(devicePath),
          fingerprint: `${program.dev}:${program.ino}`,
        });
      }
    } catch {
      // A mount may disappear while discovery is running.
    }
  }

  return devices;
}

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

async function directoriesAt(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

async function linuxMountPaths() {
  try {
    const mounts = await readFile("/proc/mounts", "utf8");
    return mounts
      .split("\n")
      .map((line) => line.split(" ")[1])
      .filter((mountPath) => typeof mountPath === "string")
      .map(decodeMountPath);
  } catch {
    return [];
  }
}

export async function mountedDevicePaths(platform = process.platform) {
  if (platform === "darwin") {
    return directoriesAt("/Volumes");
  }
  if (platform === "linux") {
    return linuxMountPaths();
  }
  if (platform === "win32") {
    return Array.from({ length: 26 }, (_, index) => `${String.fromCharCode(65 + index)}:\\`);
  }
  return [];
}

export function parseAgentList(output) {
  let response;
  try {
    response = JSON.parse(output);
  } catch {
    throw new Error("Herdr returned invalid JSON for agent list");
  }

  if (!isRecord(response) || !isRecord(response.result) || response.result.type !== "agent_list") {
    throw new Error("Herdr did not return an agent list");
  }
  if (!Array.isArray(response.result.agents)) {
    throw new Error("Herdr agent list did not contain agents");
  }

  return response.result.agents.filter(
    (agent) =>
      isRecord(agent) &&
      typeof agent.terminal_id === "string" &&
      typeof agent.agent_status === "string" &&
      validSequence(agent.state_change_seq),
  );
}
