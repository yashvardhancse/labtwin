"""Simulation behaviour and determinism tests (mirror sim.test.ts)."""

import pytest
from labtwin_sim.examples import STANDARD, load_protocol
from labtwin_sim.sim import simulate
from labtwin_sim.topics import AXIS_TOPIC


def run_standard(seed=42):
    name, steps = load_protocol(STANDARD)
    return simulate(steps, name, seed=seed)


def pump_totals(sim):
    series = sim.log.series("/pump/state")
    aspirated = dispensed = 0.0
    for i in range(1, len(series)):
        delta = series[i][1]["volume_nl"] - series[i - 1][1]["volume_nl"]
        if delta > 0:
            aspirated += delta
        else:
            dispensed -= delta
    return round(aspirated, 3), round(dispensed, 3)


def test_runs_to_completion():
    sim = run_standard()
    assert sim.executor.state == "succeeded"
    assert sim.executor.steps_succeeded == sim.executor.total_steps == 11
    assert 10_000 < sim.log.duration_ms < 30_000


def test_deterministic_per_seed():
    a = run_standard(7)
    b = run_standard(7)
    assert a.log.entries == b.log.entries
    assert len(a.log.entries) > 1000


def test_seed_changes_only_noise():
    a = run_standard(1)
    b = run_standard(2)
    ax = [m["cmd_mm"] for (_, m) in a.log.series(AXIS_TOPIC["x"])]
    bx = [m["cmd_mm"] for (_, m) in b.log.series(AXIS_TOPIC["x"])]
    assert ax == bx  # commanded trajectory is noise-free
    aa = [m["actual_mm"] for (_, m) in a.log.series(AXIS_TOPIC["x"])]
    ba = [m["actual_mm"] for (_, m) in b.log.series(AXIS_TOPIC["x"])]
    assert aa != ba  # measured differs by sensor noise
    assert max(abs(x - y) for x, y in zip(aa, ba, strict=False)) < 0.02


def test_pump_bookkeeping():
    aspirated, dispensed = pump_totals(run_standard())
    assert aspirated == pytest.approx(4, abs=0.01)
    assert dispensed == pytest.approx(3, abs=0.01)


def test_tracking_error_is_tens_of_microns():
    sim = run_standard()
    for axis in ("x", "y", "z"):
        errs = [abs(m["cmd_mm"] - m["actual_mm"]) * 1000 for (_, m) in sim.log.series(AXIS_TOPIC[axis])]
        peak = max(errs)
        assert 1 < peak < 120


def test_stage_cools_to_setpoint():
    sim = run_standard()
    temps = [m["celsius"] for (_, m) in sim.log.series("/stage/temperature")]
    assert temps[0] == pytest.approx(22, abs=1)
    assert abs(temps[-1] + 170) < 1


def test_dispense_waits_for_cold_stage():
    sim = run_standard()
    pump = sim.log.series("/pump/state")
    first_dispense_t = next(t for (t, m) in pump if m["mode"] == "dispensing")
    temps = [m["celsius"] for (t, m) in sim.log.series("/stage/temperature") if t <= first_dispense_t]
    assert temps[-1] <= -167
