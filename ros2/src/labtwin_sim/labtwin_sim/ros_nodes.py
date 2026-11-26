"""rclpy nodes that run the simulation and publish the ROS 2 topics.

``SimulationNode`` steps the deterministic core (``sim.py``) in real time and
publishes the same topics the browser twin and Foxglove consume, using the
message types defined in the ``labtwin_msgs`` package. The topic names, fields
and semantics match ``topics.py`` exactly, so a ``ros2 bag record`` of this node
and a file exported by the web twin describe the same machine.

Run it with::

    ros2 launch labtwin_sim bringup.launch.py example:=standard seed:=42

This module imports rclpy and labtwin_msgs, so it only runs inside a built ROS 2
workspace; the pure-Python core it drives runs anywhere.
"""

from __future__ import annotations

import rclpy
from rclpy.node import Node

from labtwin_msgs.msg import AxisState, Diagnostic, ProtocolStep, PumpState, StageTemperature

from .examples import EXAMPLES, load_protocol
from .sim import Simulation
from .topics import AXIS_TOPIC


class SimulationNode(Node):
    """Publishes a running sample-prep simulation on the ROS 2 graph."""

    def __init__(self) -> None:
        super().__init__("labtwin_simulation")
        self.declare_parameter("example", "standard")
        self.declare_parameter("seed", 42)
        self.declare_parameter("rate_hz", 100.0)
        self.declare_parameter("loop", True)

        example = str(self.get_parameter("example").value)
        self._seed = int(self.get_parameter("seed").value)
        source = EXAMPLES.get(example, EXAMPLES["standard"])
        self._name, self._steps = load_protocol(source)

        self._axis_pubs = {a: self.create_publisher(AxisState, AXIS_TOPIC[a], 10) for a in ("x", "y", "z")}
        self._pump_pub = self.create_publisher(PumpState, "/pump/state", 10)
        self._stage_pub = self.create_publisher(StageTemperature, "/stage/temperature", 10)
        self._step_pub = self.create_publisher(ProtocolStep, "/protocol/step", 10)
        self._diag_pub = self.create_publisher(Diagnostic, "/diagnostics", 10)

        self._sim = self._new_sim()
        self._cursor = 0
        self._drain()  # publish the initial state

        rate = float(self.get_parameter("rate_hz").value)
        self._timer = self.create_timer(1.0 / rate, self._on_timer)
        self.get_logger().info(f'labtwin_simulation: "{self._name}", seed {self._seed}, {rate:g} Hz')

    def _new_sim(self) -> Simulation:
        sim = Simulation(self._steps, self._name, seed=self._seed)
        sim.start()
        return sim

    def _on_timer(self) -> None:
        if self._sim.done:
            if not bool(self.get_parameter("loop").value):
                return
            self._sim = self._new_sim()
            self._cursor = 0
        else:
            self._sim.step()
        self._drain()

    def _drain(self) -> None:
        """Publish every log entry appended since the last call."""
        entries = self._sim.log.entries
        stamp = self.get_clock().now().to_msg()
        for topic, _t_ms, msg in entries[self._cursor :]:
            self._publish(topic, msg, stamp)
        self._cursor = len(entries)

    def _publish(self, topic: str, msg: dict, _stamp) -> None:
        if topic.startswith("/axis/"):
            axis = topic.split("/")[2]
            self._axis_pubs[axis].publish(
                AxisState(
                    axis=msg["axis"],
                    cmd_mm=msg["cmd_mm"],
                    actual_mm=msg["actual_mm"],
                    velocity_mm_s=msg["velocity_mm_s"],
                    homed=msg["homed"],
                )
            )
        elif topic == "/pump/state":
            self._pump_pub.publish(
                PumpState(volume_nl=msg["volume_nl"], flow_nl_s=msg["flow_nl_s"], mode=msg["mode"])
            )
        elif topic == "/stage/temperature":
            self._stage_pub.publish(StageTemperature(celsius=msg["celsius"], target_c=msg["target_c"]))
        elif topic == "/protocol/step":
            self._step_pub.publish(
                ProtocolStep(
                    index=int(msg["index"]),
                    type=msg["type"],
                    status=msg["status"],
                    line=int(msg["line"]),
                    label=msg["label"],
                )
            )
        elif topic == "/diagnostics":
            self._diag_pub.publish(Diagnostic(level=msg["level"], name=msg["name"], message=msg["message"]))


def main(args: list[str] | None = None) -> None:
    rclpy.init(args=args)
    node = SimulationNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        if rclpy.ok():
            rclpy.shutdown()


if __name__ == "__main__":
    main()
