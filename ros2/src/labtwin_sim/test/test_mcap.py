"""MCAP write/read-back tests using the official mcap Python reader."""

import json

from labtwin_sim.examples import STANDARD, load_protocol
from labtwin_sim.mcap_io import write_recording
from labtwin_sim.sim import simulate
from labtwin_sim.topics import TOPICS
from mcap.reader import make_reader

START_NS = 1_764_000_000_000_000_000


def make_file(tmp_path, seed=3):
    name, steps = load_protocol(STANDARD)
    sim = simulate(steps, name, seed=seed)
    path = tmp_path / "run.mcap"
    count = write_recording(sim, str(path), STANDARD, start_time_ns=START_NS)
    return sim, path, count


def test_round_trip_topics_and_values(tmp_path):
    sim, path, count = make_file(tmp_path)
    with open(path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        assert summary is not None and summary.statistics is not None
        assert summary.statistics.message_count == count

        read_back = {t: [] for t in TOPICS}
        for _schema, channel, message in reader.iter_messages(log_time_order=False):
            assert channel.message_encoding == "json"
            if channel.topic in read_back:
                read_back[channel.topic].append((message.log_time, json.loads(message.data)))

    for topic in TOPICS:
        original = sim.log.series(topic)
        assert len(read_back[topic]) == len(original)
        for (log_time, msg), (t_ms, orig) in zip(read_back[topic], original, strict=False):
            assert log_time == START_NS + round(t_ms * 1e6)
            assert msg == orig


def test_attachment_and_metadata(tmp_path):
    sim, path, _ = make_file(tmp_path)
    with open(path, "rb") as f:
        reader = make_reader(f)
        attachments = {a.name: a for a in reader.iter_attachments()}
        assert "protocol.yaml" in attachments
        assert b"steps:" in attachments["protocol.yaml"].data
        meta = next(m.metadata for m in reader.iter_metadata() if m.name == "labtwin.run")
        assert meta["seed"] == "3"
        assert meta["outcome"] == "succeeded"
        assert meta["protocol_name"] == sim.protocol_name
        for key in ("duration_ms", "step_count", "start_time_ns", "sim_dt_ms"):
            assert key in meta


def test_channels_have_jsonschema(tmp_path):
    _sim, path, _ = make_file(tmp_path)
    with open(path, "rb") as f:
        reader = make_reader(f)
        summary = reader.get_summary()
        by_topic = {}
        for channel in summary.channels.values():
            schema = summary.schemas[channel.schema_id]
            by_topic[channel.topic] = schema
        for topic in TOPICS:
            assert by_topic[topic].encoding == "jsonschema"
            assert by_topic[topic].name.startswith("labtwin.")
            json.loads(by_topic[topic].data)  # parses
