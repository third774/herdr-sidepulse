import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverDevices,
  parseAgentList,
  renderProgram,
  selectDisplay,
} from "../src/sidepulse.mjs";

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
    devices.map((device) => ({ path: device.path, ledCount: device.ledCount })),
    [{ path: confirmed, ledCount: 2 }],
  );
});

test("Herdr agent-list output accepts only an agents result", () => {
  assert.deepEqual(
    parseAgentList('{"id":"cli:agent:list","result":{"type":"agent_list","agents":[]}}'),
    [],
  );
  assert.throws(() => parseAgentList('{"result":{"type":"workspace_list"}}'));
});
