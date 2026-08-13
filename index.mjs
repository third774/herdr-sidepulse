import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import {
  discoverDevices,
  mountedDevicePaths,
  parseAgentList,
  renderProgram,
  selectDisplay,
} from "./src/sidepulse.mjs";

const KEEPALIVE_INTERVAL_MS = 60_000;
const COMPLETION_DURATION_MS = 1_200;
const WATCH_INTERVAL_MS = 2_000;

function log(message) {
  process.stderr.write(`[herdr-sidepulse] ${message}\n`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function statePath() {
  const stateDirectory = process.env.HERDR_PLUGIN_STATE_DIR ?? tmpdir();
  return join(stateDirectory, "herdr-sidepulse-state.json");
}

async function readState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Missing or invalid state is equivalent to a first run.
  }
  return {};
}

async function writeState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function configuredDevicePaths() {
  const configDirectory = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (configDirectory === undefined) {
    return [];
  }

  try {
    const config = JSON.parse(await readFile(join(configDirectory, "devices.json"), "utf8"));
    if (!isRecord(config) || !Array.isArray(config.devicePaths)) {
      return [];
    }
    return config.devicePaths.filter((devicePath) => typeof devicePath === "string");
  } catch {
    return [];
  }
}

async function herdrAgentList() {
  const herdr = process.env.HERDR_BIN_PATH ?? "herdr";
  const result = await new Promise((resolvePromise, reject) => {
    const child = spawn(herdr, ["agent", "list"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout);
        return;
      }
      reject(new Error(`herdr agent list failed (${code ?? "unknown"}): ${stderr.trim()}`));
    });
  });

  return parseAgentList(result);
}

function renderedSignature(display, devices) {
  return JSON.stringify(
    devices.map((device) => ({
      fingerprint: device.fingerprint,
      path: device.path,
      program: renderProgram(display, device.ledCount),
    })),
  );
}

async function writePrograms(display, devices) {
  const results = await Promise.all(
    devices.map(async (device) => {
      const programPath = join(device.path, "LEDS.LED");
      try {
        await writeFile(programPath, renderProgram(display, device.ledCount), "utf8");
        return true;
      } catch (error) {
        log(`could not write ${programPath}: ${String(error)}`);
        return false;
      }
    }),
  );
  return results.every(Boolean);
}

async function refreshKeepalives(devices) {
  if (process.platform !== "darwin") {
    return;
  }

  await Promise.all(
    devices.map(async (device) => {
      const keepalivePath = join(device.path, "keepalive");
      try {
        const now = new Date();
        await utimes(keepalivePath, now, now);
      } catch {
        // SidePulse Dot does not need a keepalive file.
      }
    }),
  );
}

async function withStateLock(operation) {
  const lockPath = `${statePath()}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST") {
      return;
    }
    throw error;
  }

  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function refresh({ keepalive = false, followCompletion = true } = {}) {
  const shouldFollowCompletion = await withStateLock(async () => {
    const [configuredPaths, mountedPaths, agents] = await Promise.all([
      configuredDevicePaths(),
      mountedDevicePaths(),
      herdrAgentList(),
    ]);
    const devices = await discoverDevices([...configuredPaths, ...mountedPaths]);
    const path = statePath();
    const state = await readState(path);
    const decision = selectDisplay(agents, state.doneSequences);
    const signature = renderedSignature(decision.display, devices);
    const shouldWrite = state.renderedSignature !== signature;

    if (shouldWrite && devices.length > 0) {
      const allWritten = await writePrograms(decision.display, devices);
      if (allWritten) {
        state.renderedSignature = signature;
      } else {
        delete state.renderedSignature;
      }
    }
    if (devices.length === 0) {
      state.renderedSignature = signature;
    }

    state.doneSequences = decision.doneSequences;
    await writeState(path, state);

    if (keepalive) {
      await refreshKeepalives(devices);
    }

    return decision.display === "completed" && followCompletion;
  });

  if (shouldFollowCompletion) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, COMPLETION_DURATION_MS));
    return refresh({ keepalive, followCompletion: false });
  }
}

async function watch() {
  let lastKeepalive = 0;
  while (true) {
    const now = Date.now();
    const keepalive = now - lastKeepalive >= KEEPALIVE_INTERVAL_MS;
    await refresh({ keepalive });
    if (keepalive) {
      lastKeepalive = now;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, WATCH_INTERVAL_MS));
  }
}

const command = process.argv[2] ?? "refresh";
if (command === "refresh") {
  refresh().catch((error) => {
    log(String(error));
    process.exitCode = 1;
  });
} else if (command === "watch") {
  watch().catch((error) => {
    log(String(error));
    process.exitCode = 1;
  });
} else {
  process.stderr.write("usage: node index.mjs [refresh|watch]\n");
  process.exitCode = 2;
}
