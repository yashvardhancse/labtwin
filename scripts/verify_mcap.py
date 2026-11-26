#!/usr/bin/env python3
"""Independent check of a LabTwin recording with the official MCAP Python reader.

    pip install -r scripts/requirements.txt
    python scripts/verify_mcap.py recording.mcap [more.mcap ...]

The browser app writes MCAP with the TypeScript library (@mcap/core). This script
reads the same file with a separate implementation (the `mcap` Python package)
and checks everything LabTwin promises about its recordings:

* the summary section and statistics are present (needed for fast seeking),
* every channel uses JSON messages with a JSON Schema, and each schema parses,
* the core LabTwin topics are present and every message is valid JSON,
* log times never go backwards within a channel,
* the protocol YAML is attached and the run metadata is complete,
* the Foxglove topics (/tf, /scene, /log) use Foxglove's well-known schema names.

Exit status 0 means the file passed every check.
"""

from __future__ import annotations

import json
import sys
from collections import Counter

from mcap.reader import make_reader

CORE_TOPICS = (
    "/axis/x/state",
    "/axis/y/state",
    "/axis/z/state",
    "/pump/state",
    "/stage/temperature",
    "/protocol/step",
    "/diagnostics",
)
FOXGLOVE_TOPICS = {
    "/tf": "foxglove.FrameTransforms",
    "/scene": "foxglove.SceneUpdate",
    "/log": "foxglove.Log",
}
REQUIRED_METADATA = ("protocol_name", "seed", "duration_ms", "step_count", "outcome", "start_time_ns")


def verify(path: str) -> list[str]:
    problems: list[str] = []
    with open(path, "rb") as stream:
        reader = make_reader(stream)

        summary = reader.get_summary()
        if summary is None or summary.statistics is None:
            return [f"{path}: no summary section with statistics"]

        topics = {}
        for channel in summary.channels.values():
            schema = summary.schemas.get(channel.schema_id)
            topics[channel.topic] = schema.name if schema else ""
            if channel.message_encoding != "json":
                problems.append(f"{channel.topic}: message encoding is {channel.message_encoding!r}, expected 'json'")
            if schema is None or schema.encoding != "jsonschema":
                problems.append(f"{channel.topic}: expected a jsonschema schema")
            else:
                try:
                    json.loads(schema.data)
                except ValueError as err:
                    problems.append(f"{channel.topic}: schema {schema.name} is not valid JSON ({err})")

        for topic in CORE_TOPICS:
            if topic not in topics:
                problems.append(f"missing core topic {topic}")
        for topic, schema_name in FOXGLOVE_TOPICS.items():
            if topics.get(topic) != schema_name:
                problems.append(f"{topic}: expected schema {schema_name}, found {topics.get(topic)!r}")

        counts: Counter[str] = Counter()
        last_log_time: dict[str, int] = {}
        for _schema, channel, message in reader.iter_messages(log_time_order=False):
            counts[channel.topic] += 1
            try:
                json.loads(message.data)
            except ValueError:
                problems.append(f"{channel.topic}: message {message.sequence} is not valid JSON")
            if message.log_time < last_log_time.get(channel.topic, 0):
                problems.append(f"{channel.topic}: log time goes backwards at sequence {message.sequence}")
            last_log_time[channel.topic] = message.log_time

        if sum(counts.values()) != summary.statistics.message_count:
            problems.append(
                f"statistics say {summary.statistics.message_count} messages, read {sum(counts.values())}"
            )

        attachments = {a.name: a for a in reader.iter_attachments()}
        if "protocol.yaml" not in attachments:
            problems.append("protocol.yaml attachment is missing")
        elif b"steps:" not in attachments["protocol.yaml"].data:
            problems.append("protocol.yaml attachment does not look like a protocol")

        run = next((m.metadata for m in reader.iter_metadata() if m.name == "labtwin.run"), None)
        if run is None:
            problems.append("labtwin.run metadata record is missing")
        else:
            problems += [f"metadata key {key!r} is missing" for key in REQUIRED_METADATA if key not in run]

    duration_s = (summary.statistics.message_end_time - summary.statistics.message_start_time) / 1e9
    print(f"{path}")
    print(f"  {summary.statistics.message_count} messages on {len(topics)} channels, {duration_s:.2f} s")
    for topic in sorted(topics):
        print(f"  {topic:<22} {counts[topic]:>6}  {topics[topic]}")
    if run:
        print(f"  run: {run.get('protocol_name')!r}, seed {run.get('seed')}, outcome {run.get('outcome')}")
    return problems


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 2
    failed = False
    for path in paths:
        problems = verify(path)
        for problem in problems:
            print(f"  FAIL {problem}")
        print("  OK: valid LabTwin recording" if not problems else f"  {len(problems)} problem(s)")
        failed = failed or bool(problems)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
