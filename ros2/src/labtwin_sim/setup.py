from setuptools import find_packages, setup

package_name = "labtwin_sim"

setup(
    name=package_name,
    version="0.1.0",
    packages=find_packages(exclude=["test"]),
    data_files=[
        ("share/ament_index/resource_index/packages", ["resource/" + package_name]),
        ("share/" + package_name, ["package.xml"]),
        ("share/" + package_name + "/launch", ["launch/bringup.launch.py"]),
    ],
    install_requires=["setuptools"],
    zip_safe=True,
    maintainer="LabTwin contributors",
    maintainer_email="noreply@example.com",
    description="Deterministic sample-prep robot simulation publishing ROS 2 topics.",
    license="MIT",
    tests_require=["pytest"],
    entry_points={
        "console_scripts": [
            "simulation = labtwin_sim.ros_nodes:main",
            "run = labtwin_sim.run:main",
        ],
    },
)
