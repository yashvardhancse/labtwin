"""CLI: run an example protocol headless and write a LabTwin-compatible MCAP.

    python -m labtwin_sim.run standard out.mcap --seed 42

No ROS 2 required (this is the pure-Python core). The resulting file opens in
the LabTwin web app's "Open recording" and in Foxglove.
"""

from __future__ import annotations

import argparse
import time

from .examples import EXAMPLES, load_protocol
from .mcap_io import write_recording
from .sim import DEFAULT_SEED, simulate


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run a sample-prep protocol and write an MCAP recording.")
    parser.add_argument("example", nargs="?", default="standard", choices=sorted(EXAMPLES))
    parser.add_argument("output", nargs="?", default=None)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    args = parser.parse_args(argv)

    source = EXAMPLES[args.example]
    name, steps = load_protocol(source)
    sim = simulate(steps, name, seed=args.seed)

    output = args.output or f"{args.example}.mcap"
    count = write_recording(sim, output, source, start_time_ns=time.time_ns())

    print(f'{name}: {sim.executor.state} in {sim.log.duration_ms / 1000:.2f} s, seed {args.seed}')
    print(f"  {sim.executor.steps_succeeded}/{sim.executor.total_steps} steps · {count} messages")
    print(f"  wrote {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
