"""Write a run as LabTwin-compatible MCAP (JSON encoding, JSON Schema per topic).

The layout matches the browser twin's writer exactly — same topic names, schema
titles, the protocol YAML as an attachment and a ``labtwin.run`` metadata
record — so the file opens in the LabTwin web app's "Open recording" and in
Foxglove. This is the interop bridge between the Python/ROS 2 side and the web
twin.
"""

from __future__ import annotations

import json

from mcap.writer import CompressionType, Writer

from .sim import Simulation
from .topics import TOPIC_INFO, TOPICS

RUN_METADATA = "labtwin.run"
PROTOCOL_ATTACHMENT = "protocol.yaml"


def write_recording(
    sim: Simulation,
    path: str,
    protocol_yaml: str,
    start_time_ns: int,
    *,
    library: str = "labtwin_sim (rclpy) via mcap-python",
) -> int:
    """Write the run to ``path`` and return the number of messages written."""
    with open(path, "wb") as stream:
        # No chunk compression: the browser twin reads JSON-MCAP without a zstd
        # decoder, so a Python-written file opens there directly.
        writer = Writer(stream, compression=CompressionType.NONE, chunk_size=256 * 1024)
        writer.start(profile="", library=library)

        schema_ids: dict[str, int] = {}
        channel_ids: dict[str, int] = {}
        sequences: dict[int, int] = {}
        present = {topic for (topic, _, _) in sim.log.entries}
        for topic in TOPICS:
            if topic not in present:
                continue
            info = TOPIC_INFO[topic]
            name = info["schema"]
            if name not in schema_ids:
                schema_ids[name] = writer.register_schema(
                    name=name, encoding="jsonschema", data=json.dumps(info["json_schema"]).encode()
                )
            channel_ids[topic] = writer.register_channel(
                topic=topic, message_encoding="json", schema_id=schema_ids[name]
            )

        count = 0
        for topic, t_ms, msg in sim.log.entries:
            channel_id = channel_ids.get(topic)
            if channel_id is None:
                continue
            log_time = start_time_ns + int(round(t_ms * 1e6))
            seq = sequences.get(channel_id, 0)
            sequences[channel_id] = seq + 1
            writer.add_message(
                channel_id=channel_id,
                log_time=log_time,
                publish_time=log_time,
                sequence=seq,
                data=json.dumps(msg).encode(),
            )
            count += 1

        writer.add_attachment(
            create_time=start_time_ns,
            log_time=start_time_ns,
            name=PROTOCOL_ATTACHMENT,
            media_type="application/yaml",
            data=protocol_yaml.encode(),
        )
        writer.add_metadata(
            name=RUN_METADATA,
            data={
                "protocol_name": sim.protocol_name,
                "seed": str(sim.seed),
                "duration_ms": str(int(sim.log.duration_ms)),
                "step_count": str(sim.executor.total_steps),
                "outcome": sim.executor.state,
                "start_time_ns": str(start_time_ns),
                "sim_dt_ms": str(sim.dt_ms),
                "generator": "labtwin_sim",
                "machine": "nanolitre sample-prep robot (simulated)",
            },
        )
        writer.finish()
        return count
