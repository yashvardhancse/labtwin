"""Example protocols, parsed from the same YAML the browser twin uses."""

from __future__ import annotations

import re

import yaml

from .machine import Step

STANDARD = """name: Grid prep - standard
steps:
  - home: {}
  - cool_stage: { target_c: -170, wait: false }
  - move: { x: 100, y: 60, z: 20, speed: 60 }
  - move: { z: 4, speed: 15 }
  - aspirate: { volume_nl: 4 }
  - move: { z: 30, speed: 30 }
  - move: { x: 40, y: 25, z: 8, speed: 60 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 3 }
  - wait: { ms: 500 }
  - move: { z: 30 }
"""

SERIES = """name: Four-grid series
steps:
  - home: {}
  - cool_stage: { target_c: -175 }
  - move: { x: 100, y: 60, z: 20, speed: 80 }
  - move: { z: 4, speed: 15 }
  - aspirate: { volume_nl: 9, rate_nl_s: 4 }
  - move: { z: 20, speed: 30 }
  - move: { x: 40, y: 25, z: 6, speed: 80 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 6, speed: 20 }
  - move: { x: 50, speed: 40 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 6, speed: 20 }
  - move: { x: 60, speed: 40 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 6, speed: 20 }
  - move: { x: 70, speed: 40 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 30, speed: 30 }
"""

EXAMPLES = {"standard": STANDARD, "series": SERIES}


def load_protocol(source: str) -> tuple[str, list[Step]]:
    """Parse a protocol YAML into a name and normalised steps with source lines."""
    doc = yaml.safe_load(source)
    if not isinstance(doc, dict) or not isinstance(doc.get("steps"), list):
        raise ValueError("A protocol needs a 'name' and a 'steps' list.")
    name = str(doc.get("name", "Untitled protocol"))
    # 1-based source line of each '- <step>' item, to match the web editor.
    step_lines = [i + 1 for i, line in enumerate(source.splitlines()) if re.match(r"^\s*-\s", line)]
    steps: list[Step] = []
    for index, raw in enumerate(doc["steps"]):
        if not isinstance(raw, dict) or len(raw) != 1:
            raise ValueError(f"Step {index + 1} must be a single-key mapping.")
        step_type, params = next(iter(raw.items()))
        line = step_lines[index] if index < len(step_lines) else index + 3
        steps.append(Step(index=index, type=str(step_type), line=line, params=dict(params or {})))
    return name, steps
