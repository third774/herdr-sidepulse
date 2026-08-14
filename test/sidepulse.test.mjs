import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  discoverDevices,
  parseAgentList,
  renderProgram,
  selectDisplay,
} from "../src/sidepulse.mjs";

const runFile = promisify(execFile);
const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test("blocked agents take priority over working and completed agents", () => {
  const result = selectDisplay(
    [
      { terminal_id: "done", agent_status: "done", state_change_seq: 1 },
      { terminal_id: "working", agent_status: "working", state_change_seq: 2 },
      { terminal_id: "blocked", agent_status: "blocked", state_change_seq: 3 },
    ],
    {},
  );

  assert.equal(result.display, "blocked");
  assert.deepEqual(result.doneSequences, {});
});

test("a completion is shown once, then the display returns to idle", () => {
  const agents = [{ terminal_id: "done", agent_status: "done", state_change_seq: 7 }];

  const first = selectDisplay(agents, {});
  const second = selectDisplay(agents, first.doneSequences);

  assert.equal(first.display, "completed");
  assert.deepEqual(first.doneSequences, { done: 7 });
  assert.equal(second.display, "idle");
});

test("working agents defer a completion confirmation until they finish", () => {
  const agents = [
    { terminal_id: "done", agent_status: "done", state_change_seq: 7 },
    { terminal_id: "working", agent_status: "working", state_change_seq: 8 },
  ];

  const whileWorking = selectDisplay(agents, {});
  const afterWorking = selectDisplay([agents[0]], whileWorking.doneSequences);

  assert.equal(whileWorking.display, "working");
  assert.equal(afterWorking.display, "completed");
});

test("working programs target only LEDs available on the device", () => {
  const dot = renderProgram("working", 2);
  const pro = renderProgram("working", 8);

  assert.match(dot, /0:#00c8dd/);
  assert.match(dot, /1:#00c8dd/);
  assert.doesNotMatch(dot, /2:#00c8dd/);
  assert.match(pro, /7:#00c8dd/);
});

test("every program stays within SidePulse controller limits", () => {
  for (const display of ["idle", "working", "blocked", "completed"]) {
    for (const ledCount of [2, 8]) {
      const program = renderProgram(display, ledCount);

      assert.ok(Buffer.byteLength(program) <= 512, display);
      assert.ok(program.split("\n").length <= 20, display);
    }
  }
});

test("device discovery requires an existing LEDS.LED file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-sidepulse-"));
  const confirmed = join(root, "SidePulseDot");
  const rejected = join(root, "other-volume");
  await mkdir(confirmed);
  await mkdir(rejected);
  await writeFile(join(confirmed, "LEDS.LED"), "off\n");
  t.after(async () => rm(root, { force: true, recursive: true }));

  const devices = await discoverDevices([confirmed, rejected]);

  assert.deepEqual(
    devices.map((device) => ({ path: device.path, model: device.model, ledCount: device.ledCount })),
    [{ path: confirmed, model: "dot", ledCount: 2 }],
  );
});

test("a confirmed SidePulse Pro is distinguished from unknown LED devices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-sidepulse-"));
  const pro = join(root, "SidePulsePro");
  const unknown = join(root, "other-led-device");
  await mkdir(pro);
  await mkdir(unknown);
  await writeFile(join(pro, "LEDS.LED"), "off\n");
  await writeFile(join(unknown, "LEDS.LED"), "off\n");
  t.after(async () => rm(root, { force: true, recursive: true }));

  const devices = await discoverDevices([pro, unknown]);

  assert.deepEqual(
    devices.map((device) => ({ path: device.path, model: device.model })),
    [
      { path: pro, model: "pro" },
      { path: unknown, model: "unknown" },
    ],
  );
});

test("Herdr agent-list output accepts only an agents result", () => {
  assert.deepEqual(
    parseAgentList('{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}'),
    [],
  );
  assert.throws(() => parseAgentList('{"result":{"type":"workspace_list"}}'));
});

test("toggle turns confirmed SidePulse devices off", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-sidepulse-toggle-"));
  const configDirectory = join(root, "config");
  const stateDirectory = join(root, "state");
  const device = join(root, "SidePulseDot");
  await mkdir(configDirectory);
  await mkdir(stateDirectory);
  await mkdir(device);
  await writeFile(join(configDirectory, "devices.json"), JSON.stringify({ devicePaths: [device] }));
  await writeFile(join(device, "LEDS.LED"), "#00c8dd\n");
  t.after(async () => rm(root, { force: true, recursive: true }));

  await runFile(process.execPath, [join(pluginRoot, "index.mjs"), "toggle"], {
    env: {
      ...process.env,
      HERDR_PLUGIN_CONFIG_DIR: configDirectory,
      HERDR_PLUGIN_STATE_DIR: stateDirectory,
    },
  });

  assert.equal(await readFile(join(device, "LEDS.LED"), "utf8"), "off");
});

test("refresh recovers a stale lock and renders a newer queued state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "herdr-sidepulse-refresh-"));
  const configDirectory = join(root, "config");
  const stateDirectory = join(root, "state");
  const device = join(root, "SidePulseDot");
  const fakeHerdr = join(root, "agent");
  const startedPath = join(root, "first-agent-list-started");
  await mkdir(configDirectory);
  await mkdir(stateDirectory);
  await mkdir(device);
  await writeFile(join(stateDirectory, "herdr-sidepulse-state.json.lock"), "999999999\n");
  await writeFile(join(configDirectory, "devices.json"), JSON.stringify({ devicePaths: [device] }));
  await writeFile(join(device, "LEDS.LED"), "off\n");
  await writeFile(
    fakeHerdr,
    `const { existsSync, writeFileSync } = require("node:fs");

const startedPath = process.env.SIDEPULSE_TEST_STARTED_PATH;
if (!existsSync(startedPath)) {
  writeFileSync(startedPath, "");
  setTimeout(() => {
    process.stdout.write('{"result":{"type":"agent_list","agents":[{"terminal_id":"blocked","agent_status":"blocked","state_change_seq":1}]}}');
  }, 150);
} else {
  process.stdout.write('{"result":{"type":"agent_list","agents":[{"terminal_id":"working","agent_status":"working","state_change_seq":2}]}}');
}
`,
    "utf8",
  );
  t.after(async () => rm(root, { force: true, recursive: true }));

  const environment = {
    ...process.env,
    HERDR_BIN_PATH: process.execPath,
    HERDR_PLUGIN_CONFIG_DIR: configDirectory,
    HERDR_PLUGIN_STATE_DIR: stateDirectory,
    SIDEPULSE_TEST_STARTED_PATH: startedPath,
  };
  const firstRefresh = runFile(process.execPath, [join(pluginRoot, "index.mjs"), "refresh"], {
    cwd: root,
    env: environment,
  });
  await waitForFile(startedPath);
  const secondRefresh = runFile(process.execPath, [join(pluginRoot, "index.mjs"), "refresh"], {
    cwd: root,
    env: environment,
  });

  await Promise.all([firstRefresh, secondRefresh]);

  assert.match(await readFile(join(device, "LEDS.LED"), "utf8"), /0:#00c8dd/);
});
