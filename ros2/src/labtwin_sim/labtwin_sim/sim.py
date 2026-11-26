"""Fixed-step simulation orchestrator and an in-memory run log.

Mirrors ``src/core/sim.ts``: a 10 ms tick runs the executor, then the gantry
(1 kHz servo sub-steps), pump and stage, then publishes topics at their rates.
Deterministic for a given seed.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .machine import (
    AXES,
    DEFAULT_MACHINE,
    GantryDriver,
    MachineConfig,
    Noise,
    ProtocolExecutor,
    PumpDriver,
    StageController,
    Step,
    derive_seed,
)
from .topics import AXIS_TOPIC

DEFAULT_SEED = 42
DEFAULT_DT_MS = 10


@dataclass
class RunLog:
    entries: list[tuple[str, float, dict]] = field(default_factory=list)
    duration_ms: float = 0.0

    def append(self, topic: str, t_ms: float, msg: dict) -> None:
        self.entries.append((topic, t_ms, msg))
        if t_ms > self.duration_ms:
            self.duration_ms = t_ms

    def series(self, topic: str) -> list[tuple[float, dict]]:
        return [(t, m) for (tp, t, m) in self.entries if tp == topic]


class Simulation:
    def __init__(
        self,
        steps: list[Step],
        protocol_name: str,
        seed: int = DEFAULT_SEED,
        machine: MachineConfig = DEFAULT_MACHINE,
        dt_ms: int = DEFAULT_DT_MS,
        max_duration_ms: int = 600_000,
    ) -> None:
        self.machine = machine
        self.seed = seed
        self.dt_ms = dt_ms
        self.protocol_name = protocol_name
        self._max_ticks = max_duration_ms // dt_ms
        self.log = RunLog()
        self.gantry = GantryDriver(machine, Noise(derive_seed(seed, 1)))
        self.pump = PumpDriver(machine)
        self.stage = StageController(machine, Noise(derive_seed(seed, 2)))
        self.executor = ProtocolExecutor(steps, protocol_name, self.gantry, self.pump, self.stage, machine, self._emit)
        self._tick = 0
        self._started = False
        self._last_pump_mode = self.pump.mode

    @property
    def time_ms(self) -> float:
        return self._tick * self.dt_ms

    @property
    def done(self) -> bool:
        return self._started and self.executor.state != "running"

    def _emit(self, topic: str, msg: dict) -> None:
        self.log.append(topic, self.time_ms, msg)

    def _publish_axes(self) -> None:
        for a in AXES:
            self.log.append(AXIS_TOPIC[a], self.time_ms, self.gantry.message(a))

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._publish_axes()
        self.log.append("/pump/state", self.time_ms, self.pump.message())
        self.log.append("/stage/temperature", self.time_ms, self.stage.message())
        self.executor.start()

    def step(self) -> None:
        if not self._started:
            self.start()
        if self.done:
            return
        self._tick += 1
        self.executor.tick(self.time_ms)
        if self.executor.state == "running" and self._tick >= self._max_ticks:
            self.executor.abort("The run exceeded the simulation time limit.")
        dt = self.dt_ms / 1000
        self.gantry.tick(dt)
        self.pump.tick(dt)
        self.stage.tick(dt)

        finished = self.executor.state != "running"
        self._publish_axes()
        pump_changed = self.pump.mode != self._last_pump_mode
        if finished or pump_changed or self._tick % 2 == 0:
            self.log.append("/pump/state", self.time_ms, self.pump.message())
        self._last_pump_mode = self.pump.mode
        if finished or self._tick % 10 == 0:
            self.log.append("/stage/temperature", self.time_ms, self.stage.message())

    def run_to_end(self) -> None:
        if not self._started:
            self.start()
        while not self.done:
            self.step()


def simulate(steps: list[Step], protocol_name: str, seed: int = DEFAULT_SEED) -> Simulation:
    sim = Simulation(steps, protocol_name, seed=seed)
    sim.run_to_end()
    return sim
