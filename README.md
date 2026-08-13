# herdr-sidepulse

Herdr plugin that shows the aggregate status of every agent in every workspace
on SidePulse Pro and SidePulse Dot devices.

It does not follow focus. Start work in one workspace, wait for input in
another, and SidePulse shows the highest-priority state across both.

## Requirements

- Herdr 0.7.0 or later.
- Node.js 18 or later. The plugin has no npm dependencies.
- A SidePulse Pro or SidePulse Dot device. See the
  [SidePulse project](https://github.com/inteliwear/sidepulse) for hardware
  setup.

## Install

Install from GitHub:

```sh
herdr plugin install third774/herdr-sidepulse
```

For local development, link the working directory instead:

```sh
herdr plugin link /path/to/herdr-sidepulse
```

Manage the plugin with:

```sh
herdr plugin list
herdr plugin action list --plugin third774.sidepulse
herdr plugin uninstall third774.sidepulse
```

## Usage

Herdr refreshes SidePulse when it starts and whenever an agent changes state.
The plugin actions are global:

| Action | Command | Use |
| --- | --- | --- |
| Refresh SidePulse | `third774.sidepulse.refresh` | Detect connected devices and write the current agent state. |
| Watch SidePulse | `third774.sidepulse.watch` | Poll for device changes and send the Pro keepalive every minute. |
| Toggle SidePulse | `third774.sidepulse.toggle` | Toggle display output on or off. |

Run the watch action when you connect a device after Herdr starts, or when a
macOS SidePulse Pro stays connected for more than a few minutes. Herdr startup
hooks are one-shot, so the plugin does not start this polling action by itself.

No SidePulse device is required for normal Herdr use. A refresh with no
confirmed device exits cleanly and retries on the next refresh or watch cycle.

Toggle SidePulse leaves the plugin installed and its event hook active. When
you toggle it off, the plugin writes `off` to every confirmed device and future
event refreshes keep newly found devices off. Run Toggle SidePulse again to
enable output and immediately display the current agent state.

## Statuses

The plugin selects one state across all live agents. Higher rows take priority.

| Herdr state | SidePulse display |
| --- | --- |
| `blocked` | Amber heartbeat until input, approval, or a decision is provided. |
| `working` | Cyan traveling pulse. |
| New `done` state | Two cyan confirmation flashes, then the idle pattern. |
| `idle` | Dim cyan breathing pulse. |

Herdr currently has no explicit failed-agent state. Red remains reserved for a
future error status. The plugin does not treat `unknown` as an error.

## Binding A Key

Bind keys for refresh and display toggle in your Herdr config, usually
`~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+s"
type = "plugin_action"
command = "third774.sidepulse.refresh"
description = "refresh SidePulse"

[[keys.command]]
key = "prefix+shift+s"
type = "plugin_action"
command = "third774.sidepulse.toggle"
description = "toggle SidePulse"
```

Reload the config after editing it:

```sh
herdr server reload-config
```

The refresh action is normally enough. The toggle binding silences or restores
SidePulse. Do not bind `third774.sidepulse.watch` unless you want a long-running
command.

## Device Discovery

The plugin accepts only mounts that already contain `LEDS.LED`. It searches
`/Volumes` on macOS, mounted paths in `/proc/mounts` on Linux, and Windows
drive letters. It never creates `LEDS.LED` while searching.

For an explicit mount path, first locate the plugin config directory:

```sh
herdr plugin config-dir third774.sidepulse
```

Then create `devices.json` there:

```json
{
  "devicePaths": ["/Volumes/SidePulsePro"]
}
```

Each path is still checked for an existing `LEDS.LED` file.

The volume name is never proof that a mount is SidePulse. After `LEDS.LED` is
found, a mount named `SidePulseDot` uses a two-LED working animation; other
confirmed mounts use the eight-LED Pro animation. Both have the same meaning.

## How It Works

The plugin listens for `pane.agent_status_changed` events and calls:

```sh
$HERDR_BIN_PATH agent list
```

Herdr returns agents from every workspace. The plugin reduces that list to one
display state, writes an LED program to each confirmed device, and stores the
sequence numbers of completions it has already displayed. A completion flashes
only once, then the plugin restores the idle pattern.

State is stored in `herdr-sidepulse-state.json` under
`HERDR_PLUGIN_STATE_DIR`. The polling watch action also updates SidePulse Pro's
`keepalive` file on macOS once per minute.

## Local Development

```sh
herdr plugin link /path/to/herdr-sidepulse
npm test
```

The test suite covers aggregate-state priority, one-time completion feedback,
LED-program controller limits, device confirmation, and Herdr response parsing.

## Troubleshooting

List the registered actions:

```sh
herdr plugin action list --plugin third774.sidepulse
```

Check plugin command output:

```sh
herdr plugin log list --plugin third774.sidepulse
```

If an action is missing, relink or reinstall the plugin and check that Node.js
is available as `node` on your `PATH`.

If no device is found, verify that its mounted directory already contains
`LEDS.LED`, then run Refresh SidePulse or Watch SidePulse. Add the mount path to
`devices.json` when automatic discovery does not cover the machine.

If the device stays dark, run Toggle SidePulse once to restore display output,
then run Refresh SidePulse.

See [REQUIREMENTS.md](REQUIREMENTS.md) for the full behavior contract.
