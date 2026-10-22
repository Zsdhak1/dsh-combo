# DSH Combo HUD

A Devil May Cry style combo meter for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI.

Your typing charges one lane, the Agent's tool calls land hits on the other, and both climb a
nine-rung rank ladder — **D → C → B → A → S → SS → SSS → SSS+ → V**. It is a HUD, not an
assessment: the ranks reflect how a session *feels*, not how good it is.

![Ranks](https://img.shields.io/badge/ranks-D%20→%20V-ff2d95)

## What it does

Two vertical rails sit in the empty gutters on either side of the conversation column.

**YOU (left)** — every character that lands in the composer is a hit. Typing fast without
pausing raises your rank. When you stop, the meter drains slowly; crossing a rung downward
shatters the letter and reveals the new rank underneath.

**AGENT (right)** — every settled tool call is a hit. A failed call or a turn error breaks the
chain. The rank you reached stays on screen after the turn ends, so a good run is not erased
the moment it finishes.

### Effects scale with the rank

Two dials decide how loud a strike is: the **intensity slider** (how much you want to see at
all) and the **current rank** (how far the combo has climbed). They multiply, so a V-tier
strike is visibly a different size of event from a C-tier one.

| Rank | Size | Sparks | Burst layers |
| --- | --- | --- | --- |
| D | 0.46× | 9 | ring |
| A | 0.72× | 14 | ring + cut |
| S | 0.80× | 18 | 2 rings + 2 cuts + double burst |
| SSS | 0.98× | 18 | + third ring, triple cut |
| V | 1.15× | 22 | everything, plus a per-strike surge |

Past the top rung there is nothing left to climb, so the reward changes shape: every strike
fires a scaled-down burst, and the lane counts upward past its ceiling (`+47`).

### Also included

- **Hit quips** — a short line pops out of the letter on every strike, and a louder one on a
  rank-up. Toggleable.
- **Read-outs** — typing speed (CPS), the model's output tokens per second (TPS), and the live
  context size (CTX). Toggleable.
- **Move log** — the last four distinct tool names, so you can see whether the Agent is varying
  its tools or grinding the same one.
- **Personal best** — each lane keeps its historical high-water mark in `localStorage` and
  flares when the current run beats it.

## Install

The plugin is a bundle. Install it from a local checkout:

```bash
dsh plugin add /path/to/dsh-combo
```

Or, inside a running Harness session, call the Plugin Manager with
`action: install_bundle` and this directory as the target.

It installs into the **desktop** profile by default. Reload the Web page after installing;
the Client half is loaded as a browser module, not by restarting the Host.

## Configuration

Every value below is optional — omit a field and the built-in default stands. Edit the row
config in your profile's `cordis.patch.yml`:

```yaml
- id: combo
  name: dsh-combo
  config:
    intensity: 70          # default effect intensity until the slider is moved
    extraRanks: []         # extra rank names appended above V
    you:
      ladder: [7, 16, 29, 47, 70, 101, 150, 230]   # characters per rank above D
      idleMs: 3000         # silence before the meter drains
      decayPerSec: 5       # combo points lost per second
    agent:
      ladder: [2, 4, 7, 11, 16, 22, 30, 42]        # tool calls per rank above D
      idleMs: 25000
    phrases:
      you: []              # replaces the built-in lines when non-empty
      agent: []
```

The Host half validates this document and serves it to the Client half over a read-only route.
Unusable values are dropped rather than rejected, so a typo cannot disable the plugin.

### In-app settings

Settings → **General** → **Combo HUD** holds the switches and the intensity slider. These are
stored in `localStorage` and take effect immediately.

## Architecture

| File | Role |
| --- | --- |
| `index.js` | Host half. Validates the row config and serves it over `/plugins/dsh-combo/config.json`. Registers nothing else. |
| `client.js` | Browser half. The entire HUD: state machines, geometry, rendering. |
| `cordis.patch.yml` | Loader patch that inserts the plugin row. |
| `locale/*.json` | Plugin Manager title and description. |
| `icon.svg` | Plugin Manager icon. |

The Client half reads live state the composer slot already publishes — the draft projection,
the settled tool-result nodes, and the session's running flag — so no Host service, session
projection, or new session event is involved. Nothing is written back to the session log.

Rendering is split in two because the two halves live in different trees: a zero-height **probe**
inside the composer measures the conversation column and runs the state machines, then publishes
both through a module store; a **rail** component in the frame-wide overlay subscribes and paints.
The overlay is used because the composer's layout containment breaks `position: fixed`.

## Notes

- The HUD hides itself when the window is too narrow to leave a usable gutter, rather than
  covering the conversation.
- A crash on one rail is contained to that rail; the other side keeps working.
- Diagnostics are available in the console via `window.__dshCombo.geometry()`.

## License

MIT — see [LICENSE](./LICENSE).
