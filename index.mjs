import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rename, unlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";

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
const LOCK_RETRY_INTERVAL_MS = 25;
const SD_EJECT_GUARD_LABEL = "io.sidepulse.sdejectguard";

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

function programForDisplay(display, device) {
  return display === "off" ? "off" : renderProgram(display, device.ledCount);
}

function renderedSignature(display, devices) {
  return JSON.stringify(
    devices.map((device) => ({
      fingerprint: device.fingerprint,
      path: device.path,
      program: programForDisplay(display, device),
    })),
  );
}

async function writePrograms(display, devices) {
  const results = await Promise.all(
    devices.map(async (device) => {
      const programPath = join(device.path, "LEDS.LED");
      try {
        await writeFile(programPath, programForDisplay(display, device), "utf8");
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

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function warnIfProEjectGuardIsMissing(devices, state) {
  if (process.platform !== "darwin" || !devices.some((device) => device.model === "pro")) {
    delete state.proEjectGuard;
    return;
  }

  const guardPaths = [
    join(homedir(), "Library", "LaunchAgents", `${SD_EJECT_GUARD_LABEL}.plist`),
    join("/Library", "LaunchDaemons", `${SD_EJECT_GUARD_LABEL}.plist`),
  ];
  const guardInstalled = (await Promise.all(guardPaths.map(pathExists))).some(Boolean);
  if (guardInstalled) {
    delete state.proEjectGuard;
    return;
  }

  if (state.proEjectGuard !== "missing") {
    log(
      "SidePulse Pro Eject Prevention was not detected. macOS can logically eject the Pro after hibernation or a locked-screen wake. Install the upstream guard, for example: sudo sidepulse sdejectguard start --scope system",
    );
    state.proEjectGuard = "missing";
  }
}

async function lockOwnerExited(lockPath) {
  try {
    const ownerPid = Number.parseInt((await readFile(lockPath, "utf8")).trim(), 10);
    if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
      return false;
    }
    try {
      process.kill(ownerPid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  } catch {
    return false;
  }
}

async function withStateLock(operation) {
  const lockPath = `${statePath()}.lock`;
  await mkdir(dirname(lockPath), { recursive: true });
  let lock;
  while (lock === undefined) {
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      if (await lockOwnerExited(lockPath)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_RETRY_INTERVAL_MS));
    }
  }

  try {
    await lock.writeFile(`${process.pid}\n`, "utf8");
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => {});
  }
}

async function refresh({ keepalive = false, followCompletion = true } = {}) {
  const shouldFollowCompletion = await withStateLock(async () => {
    const [configuredPaths, mountedPaths] = await Promise.all([
      configuredDevicePaths(),
      mountedDevicePaths(),
    ]);
    const devices = await discoverDevices([...configuredPaths, ...mountedPaths]);
    const path = statePath();
    const state = await readState(path);
    await warnIfProEjectGuardIsMissing(devices, state);

    if (state.enabled === false) {
      const signature = renderedSignature("off", devices);
      if (state.renderedSignature !== signature && devices.length > 0) {
        const allWritten = await writePrograms("off", devices);
        if (allWritten) {
          state.renderedSignature = signature;
        } else {
          delete state.renderedSignature;
        }
      }
      if (devices.length === 0) {
        state.renderedSignature = signature;
      }
      state.doneSequences = {};
      await writeState(path, state);
      return false;
    }

    const agents = await herdrAgentList();
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

async function toggle() {
  const isEnabled = await withStateLock(async () => {
    const path = statePath();
    const state = await readState(path);
    const nextEnabled = state.enabled === false;
    state.enabled = nextEnabled;
    state.doneSequences = {};
    delete state.renderedSignature;
    await writeState(path, state);
    return nextEnabled;
  });

  if (isEnabled === undefined) {
    log("another SidePulse command is already running");
    return;
  }
  await refresh();
  log(`SidePulse ${isEnabled ? "enabled" : "disabled"}`);
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
} else if (command === "toggle") {
  toggle().catch((error) => {
    log(String(error));
    process.exitCode = 1;
  });
} else {
  process.stderr.write("usage: node index.mjs [refresh|watch|toggle]\n");
  process.exitCode = 2;
}
