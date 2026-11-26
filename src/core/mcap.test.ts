import { McapIndexedReader, McapWriter, TempBuffer } from '@mcap/core';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json' with { type: 'json' };
import { EXAMPLES } from './examples.ts';
import { readRecording, writeRecording, type RecordingMeta } from './mcap.ts';
import { simulate } from './sim.ts';
import { TOPICS } from './topics.ts';
import { validateProtocol } from './validate.ts';
import { APP_VERSION } from './version.ts';

const SOURCE = EXAMPLES[0]?.source ?? '';
const START_NS = 1_764_000_000_000_000_000n; // fixed wall-clock start for reproducible bytes

async function recordStandardRun(seed = 3) {
  const protocol = validateProtocol(SOURCE).protocol;
  if (!protocol) throw new Error('example does not validate');
  const { log, sim } = simulate(protocol, { seed });
  const meta: RecordingMeta = {
    protocolName: protocol.name,
    seed,
    durationMs: log.durationMs,
    stepCount: protocol.steps.length,
    outcome: sim.executor.state,
    startTimeNs: START_NS,
    simDtMs: sim.dtMs,
  };
  const bytes = await writeRecording(log, meta, { protocolYaml: SOURCE });
  return { log, meta, bytes };
}

describe('MCAP round trip', () => {
  it('reads back exactly the topics, message counts and values that were written', async () => {
    const { log, meta, bytes } = await recordStandardRun();
    const loaded = readRecording(bytes);

    for (const topic of TOPICS) {
      const original = log.series(topic);
      const restored = loaded.log.series(topic);
      expect(restored.t.length, topic).toBe(original.t.length);
      expect(restored.t, topic).toEqual(original.t);
      expect(restored.msgs, topic).toEqual(original.msgs);
    }
    expect(loaded.log.durationMs).toBe(log.durationMs);
    expect(loaded.protocolYaml).toBe(SOURCE);
    expect(loaded.meta).toEqual(meta);
    expect(loaded.notes).toEqual([]);
  });

  it('declares JSON channels with a JSON Schema for every topic, plus Foxglove topics', async () => {
    const { bytes } = await recordStandardRun();
    const { channels } = readRecording(bytes);
    const byTopic = new Map(channels.map((c) => [c.topic, c]));
    for (const topic of TOPICS) {
      expect(byTopic.get(topic)?.messageEncoding).toBe('json');
      expect(byTopic.get(topic)?.schemaName).toMatch(/^labtwin\./);
    }
    expect(byTopic.get('/tf')?.schemaName).toBe('foxglove.FrameTransforms');
    expect(byTopic.get('/scene')?.schemaName).toBe('foxglove.SceneUpdate');
    expect(byTopic.get('/log')?.schemaName).toBe('foxglove.Log');
  });

  it('writes a summary and indexes that an indexed reader (like Foxglove) can seek with', async () => {
    const { log, bytes } = await recordStandardRun();
    const reader = await McapIndexedReader.Initialize({ readable: new TempBuffer(bytes) });

    const topics = [...reader.channelsById.values()].map((c) => c.topic);
    expect(topics).toEqual(expect.arrayContaining([...TOPICS, '/tf', '/scene', '/log']));
    expect(reader.statistics?.messageCount).toBeGreaterThan(BigInt(log.messageCount));
    expect(reader.chunkIndexes.length).toBeGreaterThan(1);

    let count = 0;
    for await (const message of reader.readMessages({ topics: ['/axis/x/state'] })) {
      expect(message.logTime).toBeGreaterThanOrEqual(START_NS);
      count++;
    }
    expect(count).toBe(log.series('/axis/x/state').t.length);

    const attachments = [];
    for await (const attachment of reader.readAttachments()) attachments.push(attachment.name);
    expect(attachments).toEqual(['protocol.yaml']);
    const metadata = [];
    for await (const record of reader.readMetadata()) metadata.push(record);
    expect(metadata[0]?.metadata.get('seed')).toBe('3');
  });

  it('is byte-for-byte reproducible for the same seed and start time', async () => {
    const a = await recordStandardRun(11);
    const b = await recordStandardRun(11);
    expect(a.bytes).toEqual(b.bytes);
  });

  it('refuses files that are not MCAP, with an explanation', () => {
    expect(() => readRecording(new TextEncoder().encode('name: not an mcap file'))).toThrow(
      /not an MCAP file/,
    );
    expect(() => readRecording(new Uint8Array([1, 2]))).toThrow(/not an MCAP file/);
  });

  it('refuses truncated files', async () => {
    const { bytes } = await recordStandardRun();
    expect(() => readRecording(bytes.slice(0, Math.floor(bytes.length * 0.6)))).toThrow(/truncated/);
  });

  it('refuses MCAP files that contain no LabTwin topics and lists what they do contain', async () => {
    const buffer = new TempBuffer();
    const writer = new McapWriter({ writable: buffer });
    await writer.start({ profile: '', library: 'test' });
    const schemaId = await writer.registerSchema({
      name: 'x',
      encoding: 'jsonschema',
      data: new Uint8Array(),
    });
    const channelId = await writer.registerChannel({
      topic: '/camera/image',
      schemaId,
      messageEncoding: 'json',
      metadata: new Map(),
    });
    await writer.addMessage({
      channelId,
      sequence: 0,
      logTime: 1n,
      publishTime: 1n,
      data: new TextEncoder().encode('{}'),
    });
    await writer.end();
    expect(() => readRecording(buffer.get())).toThrow(/no LabTwin topics.*\/camera\/image/);
  });
});

describe('version', () => {
  it('matches package.json (written into every recording)', () => {
    expect(APP_VERSION).toBe(pkg.version);
  });
});
