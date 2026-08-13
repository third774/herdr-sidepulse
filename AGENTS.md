# herdr-sidepulse Contributor Guide

## Purpose

This repository is a dependency-free Node.js Herdr plugin. It reduces the
agent state from every Herdr workspace to one SidePulse LED program and writes
that program to every connected device.

The user-facing behavior is specified in [REQUIREMENTS.md](REQUIREMENTS.md).
Keep that file and [README.md](README.md) current when the display state model,
plugin actions, or configuration changes.

## SidePulse Hardware

[SidePulse](https://github.com/inteliwear/sidepulse) devices expose an LED
controller as a mounted filesystem. A device is confirmed only when its mount
already contains `LEDS.LED`.

- SidePulse Pro is an eight-LED SD-card device for MacBook Pro.
- SidePulse Dot is a two-LED USB-C device for macOS, Linux, and Windows.
- Writing text to `LEDS.LED` replaces the current LED program immediately.
- Pro may lose power after idle macOS SD-reader timeouts. Refresh its existing
  `keepalive` file once per minute while the watch action runs.

Never create `LEDS.LED` while discovering devices. A volume name can identify a
confirmed device's LED count, but is not sufficient proof that it is SidePulse.

The controller DSL is documented in the upstream
[LEDS_FORMAT.md](https://github.com/inteliwear/sidepulse/blob/main/LEDS_FORMAT.md).
Important limits and semantics:

- Programs have a 512-byte limit and a 20 physical-line limit.
- `repeat` loops the whole program from its first line.
- `pulse` transitions to the target color and back to the prior color.
- Indexed colors such as `0:#00c8dd` target individual LEDs.
- Extra valid LED indexes are ignored on smaller devices. Still render for the
  actual device count when it is known.
- A parse error replaces the current animation with six red error blinks.

## State Model

`src/sidepulse.mjs` owns the pure state reduction and LED rendering logic.
The display priority is fixed:

1. `blocked`: amber heartbeat. Herdr uses this for input, approval, or decision
   requests.
2. `working`: cyan traveling pulse.
3. New `done`: two cyan flashes, then idle.
4. `idle`: dim cyan breathing pulse.

Herdr does not expose a distinct failed-agent status. Do not use red for
`blocked` or `unknown`. Red is reserved for an explicit error state if Herdr
adds one.

Completion tracking uses `terminal_id` and `state_change_seq`. Do not change it
to a timer-only model: a `done` agent remains in Herdr's agent list until it is
seen, but SidePulse must flash a completion once.

## Architecture

| Location | Role |
| --- | --- |
| `herdr-plugin.toml` | Plugin metadata, startup hook, actions, and agent-status event hook. |
| `index.mjs` | Runtime command handling, Herdr CLI calls, persistent state, device writes, and watch loop. |
| `src/sidepulse.mjs` | Pure agent reduction, LED-program generation, mount discovery, and Herdr JSON parsing. |
| `test/sidepulse.test.mjs` | Node test suite, including a real temporary `LEDS.LED` integration test. |

Use `HERDR_BIN_PATH` to run `herdr agent list`. Do not use the raw Herdr socket:
its Unix socket and Windows named-pipe transports differ.

Startup hooks are one-shot. Do not turn the startup command into an unsupported
daemon. The `watch` action is the opt-in polling process for hot-plug discovery
and Pro keepalives.

The `toggle` action changes display output, not plugin enablement. While the
display is disabled, refreshes write `off` to confirmed devices. Toggling back
on must render the current aggregate state immediately.

## Device Rules

- Search `/Volumes` on macOS, `/proc/mounts` on Linux, and drive letters on
  Windows. Also use configured paths from `devices.json` in
  `HERDR_PLUGIN_CONFIG_DIR`.
- Confirm each candidate with `stat(<mount>/LEDS.LED)`. Discovery errors are
  normal for removed or unreadable mounts.
- Write directly to `LEDS.LED`; do not use temporary-file rename semantics on
  this virtual filesystem.
- Preserve write avoidance. `index.mjs` persists the rendered program signature
  and device fingerprints so a stable state does not rewrite the device.
- Treat no connected device as a successful no-op.

## Commands

```sh
npm test
node --check index.mjs
node --check src/sidepulse.mjs
git diff --check

herdr plugin link /path/to/herdr-sidepulse
herdr plugin action list --plugin third774.sidepulse
herdr plugin log list --plugin third774.sidepulse
```

`npm test` uses Node's built-in test runner. Prefer tests of observable output:
agent lists to display states, programs within controller limits, and temporary
filesystem mounts for device behavior.
