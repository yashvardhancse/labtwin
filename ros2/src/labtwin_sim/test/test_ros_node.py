"""rclpy integration smoke test.

Skipped where ROS 2 is not installed (e.g. local dev / the browser-twin CI); it
runs in the ROS 2 job, which builds the workspace first. It brings up the
simulation node and checks a real AxisState message is published.
"""

import time

import pytest

rclpy = pytest.importorskip("rclpy")
msgs = pytest.importorskip("labtwin_msgs.msg")


def test_simulation_node_publishes_axis_state():
    from labtwin_sim.ros_nodes import SimulationNode

    rclpy.init()
    try:
        node = SimulationNode()
        received = []
        node.create_subscription(msgs.AxisState, "/axis/x/state", received.append, 10)
        deadline = time.time() + 3.0
        while time.time() < deadline and not received:
            rclpy.spin_once(node, timeout_sec=0.05)
        node.destroy_node()
        assert received, "no AxisState published within 3 s"
        assert received[0].axis == "x"
        assert received[0].homed in (True, False)
    finally:
        if rclpy.ok():
            rclpy.shutdown()
