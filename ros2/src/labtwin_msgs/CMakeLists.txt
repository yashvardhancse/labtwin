cmake_minimum_required(VERSION 3.8)
project(labtwin_msgs)

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(builtin_interfaces REQUIRED)
find_package(action_msgs REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/AxisState.msg"
  "msg/PumpState.msg"
  "msg/StageTemperature.msg"
  "msg/ProtocolStep.msg"
  "msg/Diagnostic.msg"
  "action/MoveTo.action"
  "srv/Aspirate.srv"
  "srv/Dispense.srv"
  "srv/SetStageTarget.srv"
  DEPENDENCIES builtin_interfaces action_msgs
)

ament_export_dependencies(rosidl_default_runtime)
ament_package()
