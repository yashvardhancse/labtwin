"""S-curve profile tests (mirror the TypeScript scurve.test.ts)."""

import pytest
from labtwin_sim.scurve import plan_scurve, sample_scurve


def sweep(duration, dt=2e-4):
    t = 0.0
    while t < duration:
        yield t
        t += dt
    yield duration


def test_rejects_non_positive_limits():
    for args in [(10, 0, 500, 5000), (10, 50, -1, 5000), (10, 50, 500, 0)]:
        with pytest.raises(ValueError):
            plan_scurve(*args)


def test_zero_move():
    p = plan_scurve(0, 50, 500, 5000)
    assert p.duration == 0
    assert p.phases == ()
    s = sample_scurve(p, 1)
    assert (s.position, s.velocity, s.acceleration) == (0, 0, 0)


def test_reaches_target_and_rests():
    for distance in (2, 20, 200):
        p = plan_scurve(distance, 50, 500, 5000)
        end = sample_scurve(p, p.duration)
        assert end.position == pytest.approx(distance, abs=1e-6)
        assert end.velocity == 0 and end.acceleration == 0


def test_respects_limits():
    v_max, a_max, j_max = 50, 500, 5000
    p = plan_scurve(200, v_max, a_max, j_max)
    for phase in p.phases:
        assert abs(phase.jerk) <= j_max + 1e-6
    prev = sample_scurve(p, 0)
    for t in list(sweep(p.duration))[1:]:
        s = sample_scurve(p, t)
        assert abs(s.velocity) <= v_max + 1e-6
        assert abs(s.acceleration) <= a_max + 1e-6
        assert s.position >= prev.position - 1e-9
        prev = s


def test_acceleration_is_continuous():
    p = plan_scurve(120, 60, 500, 4000)
    cumulative = 0.0
    for phase in p.phases[:-1]:
        cumulative += phase.duration
        before = sample_scurve(p, cumulative - 1e-7)
        after = sample_scurve(p, cumulative + 1e-7)
        assert abs(after.acceleration - before.acceleration) < 1e-2


def test_double_integral_self_check():
    p = plan_scurve(80, 45, 400, 6000)
    dt, v, x = 1e-4, 0.0, 0.0
    t = 0.0
    while t < p.duration:
        v += sample_scurve(p, t + dt / 2).acceleration * dt
        x += v * dt
        t += dt
    assert x == pytest.approx(p.distance, abs=0.5)
    assert v == pytest.approx(0, abs=1e-2)


def test_distance_regimes():
    long = plan_scurve(300, 50, 500, 5000)
    assert long.peak_velocity == pytest.approx(50)
    medium = plan_scurve(20, 100, 500, 5000)  # >= 2 A^3 / J^2 = 10
    assert medium.peak_acceleration == pytest.approx(500)
    assert medium.peak_velocity < 100
    short = plan_scurve(5, 100, 500, 5000)  # < 10
    assert short.peak_acceleration < 500
