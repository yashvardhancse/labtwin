"""labtwin_sim: a ROS 2 simulation of a nanolitre sample-prep robot.

The pure-Python core (machine, scurve, sim, mcap_io) runs under pytest and in a
CLI; ros_nodes wraps it in rclpy nodes that publish the same topics.
"""

__version__ = "0.1.0"
