"""Bring up the simulation node.

    ros2 launch labtwin_sim bringup.launch.py example:=standard seed:=42
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration
from launch_ros.actions import Node


def generate_launch_description() -> LaunchDescription:
    example = LaunchConfiguration("example")
    seed = LaunchConfiguration("seed")
    return LaunchDescription(
        [
            DeclareLaunchArgument("example", default_value="standard", description="Protocol: standard or series"),
            DeclareLaunchArgument("seed", default_value="42", description="Random seed for reproducible noise"),
            Node(
                package="labtwin_sim",
                executable="simulation",
                name="labtwin_simulation",
                output="screen",
                parameters=[{"example": example, "seed": seed}],
            ),
        ]
    )
