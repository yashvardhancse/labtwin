"""Deterministic simulation core for the nanolitre sample-prep robot.

A Python port of the browser twin's ``src/core`` simulation: the same machine
model, jerk-limited coordinated moves, cascaded servo, exponential cooling and
protocol executor, publishing the same ROS-2-style topics. It is pure Python
(no rclpy), so it runs under pytest and in a plain CLI; ``ros_nodes.py`` wraps
these drivers in real rclpy nodes.
"""

from __future__ import annotations

import random
from collections.abc import Callable
from dataclasses import dataclass, field
from math import sqrt
from typing import Literal

from .scurve import SCurveProfile, plan_scurve, sample_scurve

Axis = Literal["x", "y", "z"]
AXES: tuple[Axis, ...] = ("x", "y", "z")
Vec3 = dict[str, float]


def vec(x: float, y: float, z: float) -> Vec3:
    return {"x": x, "y": y, "z": z}


# ── Machine configuration ────────────────────────────────────────────
@dataclass(frozen=True)
class AxisConfig:
    min: float
    max: float
    max_speed: float  # mm/s
    max_accel: float  # mm/s^2
    max_jerk: float  # mm/s^3
    home: float
    homing_speed: float


@dataclass(frozen=True)
class Servo:
    kp_pos: float
    kp_vel: float
    ki_vel: float
    integral_clamp_mm: float
    tau_current_s: float
    noise_mm: float
    in_position_mm: float
    substeps: int


@dataclass(frozen=True)
class MachineConfig:
    axes: dict[Axis, AxisConfig]
    default_speed: float
    stage_ambient_c: float
    stage_cold_enough_c: float
    stage_tolerance_c: float
    stage_tau_s: float
    stage_noise_c: float
    stage_max_wait_s: float
    pump_capacity_nl: float
    default_rate_nl_s: float
    power_on: Vec3


DEFAULT_MACHINE = MachineConfig(
    axes={
        "x": AxisConfig(0, 120, 100, 600, 9000, 0, 40),
        "y": AxisConfig(0, 80, 100, 600, 9000, 0, 40),
        "z": AxisConfig(0, 40, 40, 400, 6000, 40, 25),
    },
    default_speed=20,
    stage_ambient_c=22,
    stage_cold_enough_c=-150,
    stage_tolerance_c=2,
    stage_tau_s=1.8,
    stage_noise_c=0.04,
    stage_max_wait_s=60,
    pump_capacity_nl=10,
    default_rate_nl_s=2,
    power_on=vec(64, 46, 22),
)


def home_position(m: MachineConfig) -> Vec3:
    return vec(m.axes["x"].home, m.axes["y"].home, m.axes["z"].home)


# ── Seeded noise (mirrors the TS Irwin–Hall Gaussian) ────────────────
class Noise:
    def __init__(self, seed: int) -> None:
        self._rng = random.Random(seed & 0xFFFFFFFF)

    def gaussian(self) -> float:
        return sum(self._rng.random() for _ in range(12)) - 6.0


def derive_seed(seed: int, stream: int) -> int:
    """Independent noise stream per node, so one node's noise never shifts another's."""
    h = (seed ^ ((stream + 1) * 0x9E3779B1)) & 0xFFFFFFFF
    return h ^ (h >> 16)


# ── Coordinated jerk-limited linear move ─────────────────────────────
@dataclass
class LinearMovePlan:
    frm: Vec3
    to: Vec3
    unit: Vec3
    length: float
    profile: SCurveProfile
    effective_speed: float
    limiting_axis: Axis | None


def plan_linear_move(frm: Vec3, to: Vec3, speed: float, axes: dict[Axis, AxisConfig]) -> LinearMovePlan:
    d = {a: to[a] - frm[a] for a in AXES}
    length = sqrt(sum(d[a] * d[a] for a in AXES))
    if length == 0:
        return LinearMovePlan(dict(frm), dict(to), vec(0, 0, 0), 0.0, plan_scurve(1e-9, 1, 1, 1), speed, None)
    unit = {a: d[a] / length for a in AXES}
    v_max = speed
    a_max = float("inf")
    j_max = float("inf")
    limiting: Axis | None = None
    for a in AXES:
        u = abs(unit[a])
        if u < 1e-12:
            continue
        v_axis = axes[a].max_speed / u
        if v_axis < v_max:
            v_max, limiting = v_axis, a
        a_max = min(a_max, axes[a].max_accel / u)
        j_max = min(j_max, axes[a].max_jerk / u)
    return LinearMovePlan(dict(frm), dict(to), unit, length, plan_scurve(length, v_max, a_max, j_max), v_max, limiting)


def sample_linear_move(plan: LinearMovePlan, t: float) -> tuple[Vec3, Vec3, Vec3]:
    if t >= plan.profile.duration:
        return dict(plan.to), vec(0, 0, 0), vec(0, 0, 0)
    s = sample_scurve(plan.profile, t)
    pos = {a: plan.frm[a] + plan.unit[a] * s.position for a in AXES}
    vel = {a: plan.unit[a] * s.velocity for a in AXES}
    acc = {a: plan.unit[a] * s.acceleration for a in AXES}
    return pos, vel, acc


def _clamp(value: float, limit: float) -> float:
    return -limit if value < -limit else limit if value > limit else value


# ── Gantry driver: coordinated moves + cascaded servo ────────────────
class GantryDriver:
    name = "gantry_driver"

    def __init__(self, m: MachineConfig, noise: Noise) -> None:
        self._m = m
        self._noise = noise
        self.homed = False
        self.cmd = dict(m.power_on)
        self.cmd_vel = vec(0, 0, 0)
        self.cmd_acc = vec(0, 0, 0)
        self.act = dict(m.power_on)
        self.act_vel = vec(0, 0, 0)
        self._act_acc = vec(0, 0, 0)
        self._integ = vec(0, 0, 0)
        self._segments: list[LinearMovePlan] = []
        self._segment = 0
        self._segment_time = 0.0
        self._homing = False
        self.state = "idle"

    def send_goal_move(self, target: dict[str, float], speed: float) -> tuple[bool, str]:
        if self.state == "executing":
            return False, "A motion goal is already executing."
        if not self.homed:
            return False, "The axes are not homed."
        if not speed > 0:
            return False, "Speed must be positive."
        tgt = {a: target.get(a, self.cmd[a]) for a in AXES}
        for a in AXES:
            cfg = self._m.axes[a]
            if tgt[a] < cfg.min - 1e-9 or tgt[a] > cfg.max + 1e-9:
                return False, f"{a.upper()} target {tgt[a]} mm is outside {cfg.min}-{cfg.max} mm."
        self._segments = [plan_linear_move(self.cmd, tgt, speed, self._m.axes)]
        self._homing = False
        self._begin()
        return True, ""

    def send_goal_home(self) -> tuple[bool, str]:
        if self.state == "executing":
            return False, "A motion goal is already executing."
        home = home_position(self._m)
        lifted = {**self.cmd, "z": home["z"]}
        self._segments = [
            plan_linear_move(self.cmd, lifted, self._m.axes["z"].homing_speed, self._m.axes),
            plan_linear_move(lifted, home, self._m.axes["x"].homing_speed, self._m.axes),
        ]
        self._homing = True
        self._begin()
        return True, ""

    def _begin(self) -> None:
        self._segment = 0
        self._segment_time = 0.0
        self.state = "executing"

    def cancel(self) -> None:
        if self.state != "executing":
            return
        self._segments = []
        self.state = "aborted"
        self.cmd_vel = vec(0, 0, 0)

    def tick(self, dt: float) -> None:
        n = SERVO.substeps
        h = dt / n
        for _ in range(n):
            self._update_command(h)
            self._update_servo(h)
        if self.state == "executing" and self._segment >= len(self._segments) and self._in_position():
            if self._homing:
                self.homed = True
            self.state = "succeeded"

    def _update_command(self, h: float) -> None:
        if self.state != "executing" or self._segment >= len(self._segments):
            self.cmd_vel = vec(0, 0, 0)
            return
        self._segment_time += h
        plan = self._segments[self._segment]
        while plan and self._segment_time >= plan.profile.duration:
            self._segment_time -= plan.profile.duration
            self._segment += 1
            if self._segment >= len(self._segments):
                self.cmd = dict(plan.to)
                self.cmd_vel = vec(0, 0, 0)
                self.cmd_acc = vec(0, 0, 0)
                return
            plan = self._segments[self._segment]
        pos, vel, acc = sample_linear_move(plan, self._segment_time)
        self.cmd, self.cmd_vel, self.cmd_acc = pos, vel, acc

    def _update_servo(self, h: float) -> None:
        s = SERVO
        for a in AXES:
            position_error = self.cmd[a] - self.act[a]
            velocity_ref = self.cmd_vel[a] + s.kp_pos * position_error
            velocity_error = velocity_ref - self.act_vel[a]
            self._integ[a] = _clamp(self._integ[a] + velocity_error * h, s.integral_clamp_mm)
            accel_cmd = self.cmd_acc[a] + s.kp_vel * velocity_error + s.ki_vel * self._integ[a]
            self._act_acc[a] += (accel_cmd - self._act_acc[a]) * (h / s.tau_current_s)
            self.act_vel[a] += self._act_acc[a] * h
            self.act[a] += self.act_vel[a] * h

    def _in_position(self) -> bool:
        tol = SERVO.in_position_mm
        return all(abs(self.cmd[a] - self.act[a]) <= tol and abs(self.act_vel[a]) < 0.2 for a in AXES)

    def message(self, axis: Axis) -> dict:
        return {
            "axis": axis,
            "cmd_mm": round4(self.cmd[axis]),
            "actual_mm": round4(self.act[axis] + self._noise.gaussian() * SERVO.noise_mm),
            "velocity_mm_s": round3(self.act_vel[axis]),
            "homed": self.homed,
        }


SERVO = Servo(
    kp_pos=90,
    kp_vel=220,
    ki_vel=1400,
    integral_clamp_mm=1.5,
    tau_current_s=0.0045,
    noise_mm=0.0015,
    in_position_mm=0.003,
    substeps=10,
)


# ── Pump and stage ───────────────────────────────────────────────────
class PumpDriver:
    name = "pump_driver"

    def __init__(self, m: MachineConfig) -> None:
        self._m = m
        self.volume_nl = 0.0
        self.mode = "idle"
        self.flow_nl_s = 0.0
        self._target_nl = 0.0

    @property
    def busy(self) -> bool:
        return self.mode != "idle"

    def call(self, op: str, volume_nl: float, rate_nl_s: float) -> tuple[bool, str]:
        if self.busy:
            return False, "The pump is busy."
        if not (volume_nl > 0 and rate_nl_s > 0):
            return False, "Volume and rate must be positive."
        if op == "aspirate":
            if self.volume_nl + volume_nl > self._m.pump_capacity_nl + 1e-9:
                return False, "Aspirating would overfill the syringe."
            self._target_nl = self.volume_nl + volume_nl
            self.flow_nl_s = rate_nl_s
            self.mode = "aspirating"
        else:
            if volume_nl > self.volume_nl + 1e-9:
                return False, "Not enough sample in the syringe."
            self._target_nl = self.volume_nl - volume_nl
            self.flow_nl_s = -rate_nl_s
            self.mode = "dispensing"
        return True, ""

    def stop(self) -> None:
        self.mode = "idle"
        self.flow_nl_s = 0.0

    def tick(self, dt: float) -> None:
        if self.mode == "idle":
            return
        nxt = self.volume_nl + self.flow_nl_s * dt
        reached = nxt >= self._target_nl if self.flow_nl_s > 0 else nxt <= self._target_nl
        if reached:
            self.volume_nl = self._target_nl
            self.stop()
        else:
            self.volume_nl = nxt

    def message(self) -> dict:
        return {"volume_nl": round4(self.volume_nl), "flow_nl_s": round3(self.flow_nl_s), "mode": self.mode}


class StageController:
    name = "stage_controller"

    def __init__(self, m: MachineConfig, noise: Noise) -> None:
        self._m = m
        self._noise = noise
        self.temperature_c = m.stage_ambient_c
        self.target_c = m.stage_ambient_c

    def set_target(self, celsius: float) -> tuple[bool, str]:
        self.target_c = celsius
        return True, ""

    def at_target(self) -> bool:
        return abs(self.temperature_c - self.target_c) <= self._m.stage_tolerance_c

    def tick(self, dt: float) -> None:
        self.temperature_c += (self.target_c - self.temperature_c) * (dt / self._m.stage_tau_s)

    def message(self) -> dict:
        return {
            "celsius": round2(self.temperature_c + self._noise.gaussian() * self._m.stage_noise_c),
            "target_c": self.target_c,
        }


def round2(x: float) -> float:
    return round(x, 2) + 0.0


def round3(x: float) -> float:
    return round(x, 3) + 0.0


def round4(x: float) -> float:
    return round(x, 4) + 0.0


# ── Protocol executor ────────────────────────────────────────────────
@dataclass
class Step:
    index: int
    type: str
    line: int
    params: dict = field(default_factory=dict)


Emit = Callable[[str, dict], None]


class ProtocolExecutor:
    name = "protocol_executor"

    def __init__(
        self,
        steps: list[Step],
        protocol_name: str,
        gantry: GantryDriver,
        pump: PumpDriver,
        stage: StageController,
        m: MachineConfig,
        emit: Emit,
    ) -> None:
        self._steps = steps
        self._name = protocol_name
        self._g = gantry
        self._p = pump
        self._s = stage
        self._m = m
        self._emit = emit
        self.state = "idle"
        self._index = -1
        self._active: Step | None = None
        self._started_ms = 0.0
        self._wait_until_ms = 0.0
        self._holding = False
        self.steps_succeeded = 0

    @property
    def total_steps(self) -> int:
        return len(self._steps)

    def start(self) -> None:
        if self.state != "idle":
            return
        self.state = "running"
        self._diag("OK", f'Running "{self._name}" ({len(self._steps)} steps).')

    def tick(self, now_ms: float) -> None:
        if self.state != "running":
            return
        if self._active is not None:
            if self._poll(self._active, now_ms) != "done":
                return
            self._publish_step(self._active, "succeeded")
            self.steps_succeeded += 1
            self._active = None
        self._start_next(now_ms)

    def _ready_below_c(self) -> float:
        return min(self._s.target_c + self._m.stage_tolerance_c, self._m.stage_cold_enough_c)

    def _stage_ready(self) -> bool:
        return self._s.temperature_c <= self._ready_below_c()

    def _start_next(self, now_ms: float) -> None:
        self._index += 1
        if self._index >= len(self._steps):
            self.state = "succeeded"
            self._diag("OK", f"Protocol finished: {self.steps_succeeded} of {len(self._steps)} steps succeeded.")
            return
        step = self._steps[self._index]
        self._active = step
        self._started_ms = now_ms
        self._holding = False
        self._publish_step(step, "executing")
        p = step.params
        if step.type == "home":
            self._require(self._g.send_goal_home())
        elif step.type == "move":
            self._require(self._g.send_goal_move(p, p.get("speed", self._m.default_speed)))
        elif step.type == "aspirate":
            self._require(self._p.call("aspirate", p["volume_nl"], p.get("rate_nl_s", self._m.default_rate_nl_s)))
        elif step.type == "dispense":
            if self._stage_ready():
                self._require(self._p.call("dispense", p["volume_nl"], p.get("rate_nl_s", self._m.default_rate_nl_s)))
            else:
                self._holding = True
                self._diag("OK", f"Dispense holding until the stage reaches {self._ready_below_c():.0f} C.")
        elif step.type == "wait":
            self._wait_until_ms = now_ms + p["ms"]
        elif step.type == "cool_stage":
            self._require(self._s.set_target(p["target_c"]))

    def _poll(self, step: Step, now_ms: float) -> str:
        if step.type in ("home", "move"):
            if self._g.state == "succeeded":
                return "done"
            if self._g.state == "aborted":
                self.abort(f"Motion goal for step {step.index + 1} was aborted.")
                return "failed"
            return "running"
        if step.type == "aspirate":
            return "running" if self._p.busy else "done"
        if step.type == "dispense":
            if self._holding:
                if self._stage_ready():
                    self._holding = False
                    rate = step.params.get("rate_nl_s", self._m.default_rate_nl_s)
                    self._require(self._p.call("dispense", step.params["volume_nl"], rate))
                    return "running"
                if now_ms - self._started_ms > self._m.stage_max_wait_s * 1000:
                    self.abort(f"The stage did not get cold enough within {self._m.stage_max_wait_s} s.")
                    return "failed"
                return "running"
            return "running" if self._p.busy else "done"
        if step.type == "wait":
            return "done" if now_ms >= self._wait_until_ms else "running"
        if step.type == "cool_stage":
            return "done" if (not step.params.get("wait", True) or self._s.at_target()) else "running"
        return "done"

    def _require(self, response: tuple[bool, str]) -> None:
        ok, reason = response
        if not ok:
            self.abort(f"Step {(self._active.index if self._active else 0) + 1} was rejected: {reason}")

    def abort(self, reason: str) -> None:
        if self.state != "running":
            return
        if self._active:
            self._publish_step(self._active, "aborted")
        self._g.cancel()
        self._p.stop()
        self._active = None
        self.state = "aborted"
        self._diag("ERROR", reason)

    def _publish_step(self, step: Step, status: str) -> None:
        self._emit(
            "/protocol/step",
            {"index": step.index, "type": step.type, "status": status, "line": step.line, "label": describe(step)},
        )

    def _diag(self, level: str, message: str) -> None:
        self._emit("/diagnostics", {"level": level, "name": self.name, "message": message})


def describe(step: Step) -> str:
    p = step.params
    if step.type == "home":
        return "Home all axes"
    if step.type == "move":
        parts = [f"{a.upper()} {p[a]:g}" for a in AXES if a in p]
        return f"Move to {', '.join(parts)}"
    if step.type == "aspirate":
        return f"Aspirate {p['volume_nl']:g} nL"
    if step.type == "dispense":
        return f"Dispense {p['volume_nl']:g} nL"
    if step.type == "wait":
        return f"Wait {p['ms'] / 1000:g} s"
    if step.type == "cool_stage":
        return f"Cool stage to {p['target_c']:g} C"
    return step.type
