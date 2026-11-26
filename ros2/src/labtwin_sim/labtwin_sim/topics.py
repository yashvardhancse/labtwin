"""Topic names and JSON Schemas — the ROS-2-style interface of the robot.

These match the browser twin's ``src/core/topics.ts`` exactly (names, fields,
schema titles), so an MCAP file written here opens in the LabTwin web app and in
Foxglove, and a file exported from the web app is read back by the same checks.
"""

from __future__ import annotations

AXIS_TOPIC = {"x": "/axis/x/state", "y": "/axis/y/state", "z": "/axis/z/state"}

TOPICS = (
    "/axis/x/state",
    "/axis/y/state",
    "/axis/z/state",
    "/pump/state",
    "/stage/temperature",
    "/protocol/step",
    "/diagnostics",
)


def _num(desc: str) -> dict:
    return {"type": "number", "description": desc}


_AXIS_SCHEMA = {
    "type": "object",
    "title": "labtwin.AxisState",
    "properties": {
        "axis": {"type": "string", "enum": ["x", "y", "z"]},
        "cmd_mm": _num("Commanded position, mm"),
        "actual_mm": _num("Measured position, mm"),
        "velocity_mm_s": _num("Measured velocity, mm/s"),
        "homed": {"type": "boolean"},
    },
    "required": ["axis", "cmd_mm", "actual_mm", "velocity_mm_s", "homed"],
}

TOPIC_INFO: dict[str, dict] = {
    "/axis/x/state": {"schema": "labtwin.AxisState", "json_schema": _AXIS_SCHEMA},
    "/axis/y/state": {"schema": "labtwin.AxisState", "json_schema": _AXIS_SCHEMA},
    "/axis/z/state": {"schema": "labtwin.AxisState", "json_schema": _AXIS_SCHEMA},
    "/pump/state": {
        "schema": "labtwin.PumpState",
        "json_schema": {
            "type": "object",
            "title": "labtwin.PumpState",
            "properties": {
                "volume_nl": _num("Sample in the syringe, nL"),
                "flow_nl_s": _num("Signed flow (+ aspirate, - dispense), nL/s"),
                "mode": {"type": "string", "enum": ["idle", "aspirating", "dispensing"]},
            },
            "required": ["volume_nl", "flow_nl_s", "mode"],
        },
    },
    "/stage/temperature": {
        "schema": "labtwin.StageTemperature",
        "json_schema": {
            "type": "object",
            "title": "labtwin.StageTemperature",
            "properties": {"celsius": _num("Measured, C"), "target_c": _num("Set-point, C")},
            "required": ["celsius", "target_c"],
        },
    },
    "/protocol/step": {
        "schema": "labtwin.ProtocolStep",
        "json_schema": {
            "type": "object",
            "title": "labtwin.ProtocolStep",
            "properties": {
                "index": {"type": "integer", "minimum": 0},
                "type": {"type": "string"},
                "status": {"type": "string", "enum": ["executing", "succeeded", "aborted", "canceled"]},
                "line": {"type": "integer", "minimum": 1},
                "label": {"type": "string"},
            },
            "required": ["index", "type", "status", "line", "label"],
        },
    },
    "/diagnostics": {
        "schema": "labtwin.Diagnostic",
        "json_schema": {
            "type": "object",
            "title": "labtwin.Diagnostic",
            "properties": {
                "level": {"type": "string", "enum": ["OK", "WARN", "ERROR"]},
                "name": {"type": "string"},
                "message": {"type": "string"},
            },
            "required": ["level", "name", "message"],
        },
    },
}
