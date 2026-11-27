# labtwin_sim — a real ROS 2 package

A ROS 2 (Python / `rclpy`) counterpart to the browser twin. It runs the **same**
deterministic machine model and publishes the **same** topics, and it writes
MCAP that opens unchanged in the LabTwin web app and in Foxglove — so the web
twin and the ROS 2 stack describe one machine with one set of interfaces.

This mirrors the production split the role describes: ROS 2 nodes in Python
alongside a web interface, with runs recorded as MCAP and a 3D model.

## Packages

| Package        | Build type     | What's in it                                                                                                                                                                                  |
| -------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `labtwin_msgs` | `ament_cmake`  | The interfaces: `AxisState`, `PumpState`, `StageTemperature`, `ProtocolStep`, `Diagnostic` messages; the `MoveTo` action; the `Aspirate`, `Dispense`, `SetStageTarget` services.              |
| `labtwin_sim`  | `ament_python` | The pure-Python simulation core (`machine.py`, `scurve.py`, `sim.py`), the MCAP writer (`mcap_io.py`), a CLI (`run.py`), and the `SimulationNode` that publishes the topics (`ros_nodes.py`). |

The simulation core is a port of the web app's `src/core`: the same jerk-limited
S-curve motion, cascaded servo, exponential cooling and protocol executor, so
both sides agree on the physics and the message schemas.

## Run the pure-Python core (no ROS 2 needed)

```bash
pip install mcap pyyaml
cd ros2/src/labtwin_sim
python -m labtwin_sim.run standard out.mcap      # writes a LabTwin-compatible MCAP
pytest -q                                         # S-curve, determinism, MCAP round-trip
```

`out.mcap` opens in the LabTwin web app's **Open recording** (the 3D machine,
charts and report follow the Python-recorded state) and in Foxglove.

## Build and run as ROS 2 (Jazzy)

```bash
cd ros2
colcon build
source install/setup.bash
ros2 launch labtwin_sim bringup.launch.py example:=standard seed:=42
```

Then, in another sourced shell:

```bash
ros2 topic echo /axis/x/state          # labtwin_msgs/msg/AxisState
ros2 topic hz /stage/temperature
ros2 bag record -s mcap -o run /axis/x/state /pump/state /stage/temperature /protocol/step /diagnostics
```

CI (`.github/workflows/ros2.yml`) lints the Python package, runs its 17 tests
and verifies the MCAP interop on every push. The `colcon build` above is a
local/dev step, and the `rclpy` node smoke test (`test/test_ros_node.py`) runs
where ROS 2 is installed.

## How the two sides interoperate

Both sides use identical topic names and JSON Schemas (`topics.py` here mirrors
`src/core/topics.ts`). The Python writer emits JSON-encoded MCAP without chunk
compression, which the browser reader decodes directly. Replaying a **native**
`ros2 bag` (CDR-encoded) in the browser needs a CDR decoder — that is the one
remaining interop step (see the roadmap).
