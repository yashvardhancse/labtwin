# Architecture

This document explains how LabTwin is put together and why: the decisions, the alternatives considered, and what each one costs. The README covers usage.

## Goals and constraints

- **Static hosting only.** It has to run from GitHub Pages, so there is no backend: validation, simulation and MCAP I/O all run in the browser.
- **Reproducible.** The same protocol and seed must give the same run, and the same recording, on any machine.
- **Honest to the domain.** The structure should mirror a ROS 2 system (nodes, topics, actions, services, rosbag2-style recordings) so the design transfers to the real thing.
- **Reviewable.** Small, typed and tested modules, with a hard boundary between logic and presentation.

## Layers

```text
src/core   pure TypeScript: protocol language, validator, planner, simulator, topics, MCAP, Foxglove adapter
src/three  three.js scene, a function of core SceneState snapshots
src/ui     React components and the run/replay controller
```

`src/core` imports no React, three.js or DOM APIs, not even `Date`. ESLint enforces this with `no-restricted-imports` and `no-restricted-globals` on `src/core/**`. Because the TypeScript is also restricted to erasable syntax (`erasableSyntaxOnly`) and uses explicit `.ts` imports, the same core runs unchanged in the browser, in vitest and directly under Node: `node scripts/export-sample.ts` needs no build step. CI uses that to produce a recording for the Python cross-check.

## Data flow

```text
YAML ─▶ parseYaml (source map) ─▶ validateProtocol ─▶ Protocol
                                         │
Protocol ─▶ Simulation (fixed 10 ms tick) ─▶ Bus ─▶ RunLog ─┬─▶ sceneAt(t) ─▶ MachineView (3D)
                                                            ├─▶ chart columns ─▶ SVG charts
                                                            ├─▶ summarizeRun ─▶ run report
                                                            └─▶ writeRecording ─▶ .mcap ─▶ readRecording ─▶ RunLog …
```

## Decisions

### 1. Render only from recorded topics

The 3D view, charts and report take a `RunLog` (time-indexed messages per topic) and a playhead, and nothing else. Droplets, for example, are reconstructed from `/pump/state` mode changes plus the tip position at that moment, not read from a simulator variable.

- **Why:** live runs and replays share one rendering path, so replay cannot silently drift from live. It also forces the topic interface to be complete: whatever the UI needs must be published, which is exactly the discipline a real robot needs for useful bags.
- **Cost:** some derived state (droplets, trails) is recomputed from the log, cached per log revision, and the log is kept in memory, roughly 6 000 messages for the 15 s demo.

### 2. Deterministic, fixed-step simulation

The simulator ticks every 10 ms in a fixed node order: the executor decides, the gantry runs ten 1 ms servo sub-steps, the pump and stage integrate, then everything publishes. All time is simulation time, the equivalent of ROS 2 `use_sim_time`. Wall-clock time appears only as the recording's start offset, passed in from the UI.

Noise comes from per-node streams of a seeded mulberry32 generator. Gaussian noise is an Irwin–Hall sum of 12 uniforms rather than Box–Muller, because `Math.log`, `sin` and `cos` are not guaranteed to be bit-identical across JavaScript engines, whereas `+`, `*`, `/` and `sqrt` are. Published values are rounded (0.1 µm, 1 mK) and `-0` is normalised, so recordings stay small and survive a JSON round trip exactly.

- **Tested by:** the same seed gives identical message streams; different seeds change only the measured positions, never the commanded trajectory; and two exports of the same run are byte-identical.

### 3. Motion: coordinated trapezoids and a simple servo model

A `move` is a straight line of the needle tip. One trapezoidal profile runs along the path, with its velocity and acceleration limits set to the tightest per-axis limits projected onto the direction of travel (`v ≤ vmax_i / |u_i|`). Every axis therefore follows a scaled trapezoid, none exceeds its own limits, and all of them arrive together. That matters for a dispensing tip, which should travel predictably near the grid. If an axis caps the requested speed, the validator warns.

Each axis is modelled as velocity feed-forward plus a proportional position loop (Kp = 120 s⁻¹) driving a first-order drive lag (τ = 8 ms), integrated at 1 kHz. That gives realistic following error: tens of µm while accelerating, a damped transient at each change of acceleration, and close to zero at constant velocity. A move counts as finished once every axis is within 2 µm of its command, like an "in position" window.

- **Alternatives:** independent per-axis point-to-point moves (curved paths, simpler) or S-curve profiles (no acceleration steps). S-curves are on the roadmap; the acceleration steps of a trapezoid make the servo response easy to see in the tracking-error chart.

### 4. Validator: two phases, exact spans, and checks again at run time

js-yaml 5 exposes its parser as an event stream with source offsets. `parseYaml` builds the JavaScript value and a path-to-span index (`steps/3/move/x` → offsets) in the same pass, so diagnostics underline the exact token (`140` in `x: 140`) in both flow and block style.

- **Phase 1** checks structure and every field against one declarative spec (`stepSpecs()`), which the editor's autocompletion also uses.
- **Phase 2** dry-runs the steps against a static machine model (homed, tip position, syringe volume, stage set-point) to catch ordering and physical mistakes. Unknown state is tracked explicitly, so a single bad value does not cascade into misleading follow-up errors.
- **At run time,** the executor re-checks the preconditions that matter physically. A dispense holds until the stage is really cold and aborts after a timeout. A real controller cannot trust its input file, so the twin does not either.

### 5. MCAP with JSON and JSON Schema

Recordings use the MCAP container that rosbag2 uses by default, with JSON message encoding and a JSON Schema per message type.

- **Why JSON:** human-readable, trivially decoded in the browser, and supported by Foxglove. CDR would need a ROS message-definition parser in the browser; protobuf would need generated code.
- **Cost:** size. The 15 s demo is about 1.4 MB with uncompressed chunks. zstd or lz4 chunk compression would cut that a lot, but readers would then need WebAssembly decoders.
- **Contents:** an attachment holds the exact protocol YAML, and a metadata record holds the seed, name, outcome and timing, so a recording is self-describing and can be re-run. Chunk, message, attachment and metadata indexes plus statistics are written so indexed readers can seek.
- **Reading:** uses `McapStreamReader` with CRC checks. Unreadable input gets a plain-language error (not MCAP, truncated, compressed chunks, no LabTwin topics), and foreign messages are shape-checked before they can reach the renderers.

### 6. One machine description for every view

`machineGeometry()` lists primitives (boxes and cylinders) attached to four links: `world → gantry_y → carriage_x → head_z`. The joints are prismatic and the `head_z` origin is the needle tip, so the tool-centre point is simply `(x, y, z)`. The three.js scene and the Foxglove `/scene` export are both generated from this list, and `/tf` comes from the axis states, the role `robot_state_publisher` plays for a URDF. A URDF exporter would be a straightforward next step.

The three Foxglove JSON schemas used are vendored (about 25 kB instead of the package's 326 kB index). A test fails if they drift from `@foxglove/schemas`, and every exported `/tf`, `/scene` and `/log` message is validated against them with Ajv.

### 7. UI state outside React's render loop

`TwinController` is a small `requestAnimationFrame` state machine: idle → live (running or paused) → review, plus file replay. React subscribes through `useSyncExternalStore` on two channels: `state` (mode, speed, session), which changes rarely, and `frame` (the playhead), which changes every animation frame. The three.js view subscribes imperatively and never re-renders React. Charts recompute their columns only when the log grows.

### 8. Library choices

- **Plain three.js instead of React Three Fiber:** the scene is a framework-free class (`MachineView`) posed from snapshots. It is easy to reason about per frame, renders only when something changed, and disposes deterministically.
- **CodeMirror 6 instead of a textarea:** the lint gutter, diagnostics tooltips, autocompletion and decorations (such as the highlighted running step) come from mature, accessible building blocks.
- **Custom SVG charts instead of a chart library:** four small charts do not justify the dependency. Per-pixel min/max decimation keeps narrow tracking-error spikes visible at any width; there is a shared crosshair, and the not-yet-played part is faded during replay. Axis colours come from a categorical palette checked for colour-blind separation, and every series also has a text label.
- **Hash routing:** `#/` and `#/ros2` work on any static host with no rewrite rules.

## Testing strategy

| Layer     | How                                                                                                                                                                         |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validator | One test per error class, each warning in isolation, exact spans in flow and block YAML, did-you-mean suggestions, no cascading errors                                      |
| Planner   | Reaches the target exactly; respects velocity and acceleration limits (sampled finely); triangular case; continuity at phase boundaries; per-axis caps on coordinated moves |
| Simulator | Determinism; exact pump bookkeeping; cooling curve; publish rates; tracking-error bounds; dispense holds and timeouts; operator stop                                        |
| MCAP      | Round trip of every topic and value; attachment and metadata; indexed reading (summary, chunk indexes); byte-for-byte reproducibility; plain-language errors for bad files  |
| Interop   | A Node headless export is verified by the official Python `mcap` reader in CI                                                                                               |
| Browser   | `npm run e2e`: demo run, real download, real file input, identical report after the round trip, scrubbing                                                                   |
| Container | CI builds the Docker image and smoke-tests the served page                                                                                                                  |

## Known limitations

- The physics is a teaching-grade model with compressed time constants, not an identified model of real hardware.
- No collision model: the validator does not know that the needle could hit the vial rim on a diagonal move.
- The JSON-only replay does not read CDR-encoded rosbag2 recordings yet (see the roadmap in the README).
