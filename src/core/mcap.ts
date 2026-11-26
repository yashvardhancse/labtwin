import { MCAP_MAGIC, McapStreamReader, McapWriter, TempBuffer, hasMcapPrefix } from '@mcap/core';
import { FOXGLOVE_SCHEMAS, foxgloveMessages } from './foxglove.ts';
import { DEFAULT_MACHINE, type MachineConfig } from './machine.ts';
import { RunLog } from './runLog.ts';
import { TOPICS, TOPIC_INFO, isTopicName, type TopicName } from './topics.ts';
import { APP_NAME, APP_VERSION } from './version.ts';

/**
 * Recording and replay with MCAP — the container format rosbag2 uses by default.
 *
 * Layout of an exported file:
 *   channels     one per topic, JSON message encoding, a JSON Schema per message type
 *   messages     log time = run start (wall clock) + simulation time
 *   attachment   protocol.yaml — the exact protocol that produced the run
 *   metadata     "labtwin.run" — seed, protocol name, duration, outcome, …
 *   summary      statistics, chunk/attachment/metadata indexes (fast seeking in Foxglove)
 */

export interface RecordingMeta {
  protocolName: string;
  seed: number;
  durationMs: number;
  stepCount: number;
  outcome: string;
  /** Wall-clock start of the run, ns since the Unix epoch. */
  startTimeNs: bigint;
  simDtMs: number;
}

export interface WriteOptions {
  protocolYaml?: string;
  /** Add /tf, /scene and /log for Foxglove's 3D and Log panels (default true). */
  foxglove?: boolean;
  machine?: MachineConfig;
}

export const RUN_METADATA = 'labtwin.run';
export const PROTOCOL_ATTACHMENT = 'protocol.yaml';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const json = (value: unknown) => encoder.encode(JSON.stringify(value));

export async function writeRecording(
  log: RunLog,
  meta: RecordingMeta,
  options: WriteOptions = {},
): Promise<Uint8Array> {
  const machine = options.machine ?? DEFAULT_MACHINE;
  const buffer = new TempBuffer();
  const writer = new McapWriter({
    writable: buffer,
    useStatistics: true,
    useSummaryOffsets: true,
    useChunks: true,
    useChunkIndex: true,
    useMessageIndex: true,
    useAttachmentIndex: true,
    useMetadataIndex: true,
    chunkSize: 256 * 1024,
  });
  await writer.start({ profile: '', library: `${APP_NAME} ${APP_VERSION} (@mcap/core)` });

  const schemaIds = new Map<string, number>();
  const schemaId = async (name: string, schema: unknown) => {
    let id = schemaIds.get(name);
    if (id === undefined) {
      id = await writer.registerSchema({ name, encoding: 'jsonschema', data: json(schema) });
      schemaIds.set(name, id);
    }
    return id;
  };
  const channelIds = new Map<string, number>();
  const sequences = new Map<number, number>();
  const channel = async (topic: string, schemaName: string, schema: unknown) => {
    let id = channelIds.get(topic);
    if (id === undefined) {
      id = await writer.registerChannel({
        topic,
        schemaId: await schemaId(schemaName, schema),
        messageEncoding: 'json',
        metadata: new Map(),
      });
      channelIds.set(topic, id);
    }
    return id;
  };

  // Core topics first, in a fixed order, so channel ids are stable across exports.
  for (const topic of TOPICS) {
    if (log.series(topic).t.length > 0)
      await channel(topic, TOPIC_INFO[topic].schemaName, TOPIC_INFO[topic].jsonSchema);
  }
  const extras = options.foxglove === false ? [] : foxgloveMessages(log, meta.startTimeNs, machine);
  for (const m of extras) await channel(m.topic, m.schemaName, FOXGLOVE_SCHEMAS[m.schemaName]);

  // Merge core messages (already in publish order) with the derived ones by log time.
  const at = (tMs: number) => meta.startTimeNs + BigInt(Math.round(tMs * 1e6));
  const write = async (topic: string, logTime: bigint, msg: unknown) => {
    const channelId = channelIds.get(topic);
    if (channelId === undefined) return;
    const sequence = sequences.get(channelId) ?? 0;
    sequences.set(channelId, sequence + 1);
    await writer.addMessage({ channelId, sequence, logTime, publishTime: logTime, data: json(msg) });
  };
  let next = 0;
  for (const entry of log.entries()) {
    if (!isTopicName(entry.topic)) continue;
    const logTime = at(entry.t);
    for (let extra = extras[next]; extra && extra.logTimeNs < logTime; extra = extras[++next]) {
      await write(extra.topic, extra.logTimeNs, extra.msg);
    }
    await write(entry.topic, logTime, entry.msg);
  }
  for (; next < extras.length; next++) {
    const extra = extras[next];
    if (extra) await write(extra.topic, extra.logTimeNs, extra.msg);
  }

  if (options.protocolYaml !== undefined) {
    await writer.addAttachment({
      name: PROTOCOL_ATTACHMENT,
      mediaType: 'application/yaml',
      logTime: meta.startTimeNs,
      createTime: meta.startTimeNs,
      data: encoder.encode(options.protocolYaml),
    });
  }
  await writer.addMetadata({
    name: RUN_METADATA,
    metadata: new Map([
      ['protocol_name', meta.protocolName],
      ['seed', String(meta.seed)],
      ['duration_ms', String(meta.durationMs)],
      ['step_count', String(meta.stepCount)],
      ['outcome', meta.outcome],
      ['start_time_ns', String(meta.startTimeNs)],
      ['sim_dt_ms', String(meta.simDtMs)],
      ['generator', `${APP_NAME} ${APP_VERSION}`],
      ['machine', 'nanolitre sample-prep robot (simulated)'],
    ]),
  });
  await writer.end();
  return buffer.get();
}

export interface ChannelSummary {
  topic: string;
  schemaName: string;
  messageEncoding: string;
  messageCount: number;
}

export interface LoadedRecording {
  log: RunLog;
  meta: Partial<RecordingMeta>;
  /** Raw key/value pairs of the run metadata record. */
  metadata: Record<string, string>;
  protocolYaml: string | null;
  library: string;
  channels: ChannelSummary[];
  /** Things LabTwin skipped while reading (unsupported encodings, malformed messages). */
  notes: string[];
}

/** A recording that cannot be replayed, with a message meant for the user. */
export class RecordingError extends Error {
  override name = 'RecordingError';
}

export function readRecording(bytes: Uint8Array): LoadedRecording {
  if (
    bytes.byteLength < MCAP_MAGIC.length ||
    !hasMcapPrefix(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  ) {
    throw new RecordingError('This is not an MCAP file: it does not start with the MCAP magic bytes.');
  }
  const reader = new McapStreamReader({ validateCrcs: true });
  const schemas = new Map<number, string>();
  const channels = new Map<number, { topic: string; schemaId: number; messageEncoding: string }>();
  const raw: { channelId: number; logTime: bigint; data: Uint8Array }[] = [];
  let library = '';
  let protocolYaml: string | null = null;
  let metadata: Record<string, string> = {};

  try {
    reader.append(bytes);
    for (let record = reader.nextRecord(); record; record = reader.nextRecord()) {
      switch (record.type) {
        case 'Header':
          library = record.library;
          break;
        case 'Schema':
          schemas.set(record.id, record.name);
          break;
        case 'Channel':
          channels.set(record.id, record);
          break;
        case 'Message':
          raw.push({ channelId: record.channelId, logTime: record.logTime, data: record.data });
          break;
        case 'Attachment':
          if (
            protocolYaml === null &&
            (record.name === PROTOCOL_ATTACHMENT || record.mediaType.includes('yaml'))
          ) {
            protocolYaml = decoder.decode(record.data);
          }
          break;
        case 'Metadata':
          if (record.name === RUN_METADATA) metadata = Object.fromEntries(record.metadata);
          break;
        default:
          break;
      }
    }
  } catch (err) {
    throw new RecordingError(explainReadError(err));
  }
  if (!reader.done()) {
    throw new RecordingError(
      'The file ends before the MCAP footer, so it is probably truncated (an interrupted download?). Export the run again.',
    );
  }

  let startNs =
    metadata.start_time_ns !== undefined && /^\d+$/.test(metadata.start_time_ns)
      ? BigInt(metadata.start_time_ns)
      : null;
  for (const m of raw) if (startNs === null || m.logTime < startNs) startNs = m.logTime;
  const t0 = startNs ?? 0n;

  const log = new RunLog();
  const notes = new Set<string>();
  const counts = new Map<number, number>();
  for (const m of raw) {
    const ch = channels.get(m.channelId);
    if (!ch) continue;
    counts.set(m.channelId, (counts.get(m.channelId) ?? 0) + 1);
    if (ch.messageEncoding !== 'json') {
      notes.add(
        `Skipped ${ch.topic}: "${ch.messageEncoding}" messages are not supported (LabTwin reads JSON).`,
      );
      continue;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(decoder.decode(m.data));
    } catch {
      notes.add(`Skipped malformed JSON on ${ch.topic}.`);
      continue;
    }
    if (isTopicName(ch.topic) && !hasShape(ch.topic, msg)) {
      notes.add(`Skipped messages on ${ch.topic} that do not match the LabTwin schema.`);
      continue;
    }
    log.append(ch.topic, Number(m.logTime - t0) / 1e6, msg);
  }
  log.ensureSorted();

  const summaries: ChannelSummary[] = [...channels.entries()].map(([id, ch]) => ({
    topic: ch.topic,
    schemaName: schemas.get(ch.schemaId) ?? '',
    messageEncoding: ch.messageEncoding,
    messageCount: counts.get(id) ?? 0,
  }));
  if (!TOPICS.some((topic) => log.series(topic).t.length > 0)) {
    const found = summaries.map((c) => c.topic).join(', ') || 'no channels at all';
    throw new RecordingError(
      `This recording has no LabTwin topics (such as /axis/x/state or /pump/state). It contains: ${found}.`,
    );
  }

  const num = (key: string) => {
    const value = Number(metadata[key]);
    return metadata[key] !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const meta: Partial<RecordingMeta> = {
    ...(metadata.protocol_name !== undefined ? { protocolName: metadata.protocol_name } : {}),
    ...(metadata.outcome !== undefined ? { outcome: metadata.outcome } : {}),
    ...(num('seed') !== undefined ? { seed: num('seed') } : {}),
    ...(num('duration_ms') !== undefined ? { durationMs: num('duration_ms') } : {}),
    ...(num('step_count') !== undefined ? { stepCount: num('step_count') } : {}),
    ...(num('sim_dt_ms') !== undefined ? { simDtMs: num('sim_dt_ms') } : {}),
    ...(startNs !== null ? { startTimeNs: startNs } : {}),
  };
  return { log, meta, metadata, protocolYaml, library, channels: summaries, notes: [...notes] };
}

function explainReadError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lower = text.toLowerCase();
  if (lower.includes('magic'))
    return 'This is not an MCAP file: it does not start with the MCAP magic bytes.';
  if (lower.includes('crc'))
    return 'The file is damaged: a chunk failed its CRC check. Export the run again.';
  if (lower.includes('compression') || lower.includes('decompress')) {
    return `This recording uses compressed chunks, which LabTwin's browser reader does not decode (${text}). Save it without chunk compression and try again.`;
  }
  return `The MCAP file could not be read: ${text}`;
}

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown) => typeof v === 'string';

/** Light structural check so a foreign file cannot crash the renderers. */
function hasShape(topic: TopicName, msg: unknown): boolean {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  switch (topic) {
    case '/axis/x/state':
    case '/axis/y/state':
    case '/axis/z/state':
      return isNum(m.cmd_mm) && isNum(m.actual_mm) && isNum(m.velocity_mm_s);
    case '/pump/state':
      return isNum(m.volume_nl) && isStr(m.mode);
    case '/stage/temperature':
      return isNum(m.celsius) && isNum(m.target_c);
    case '/protocol/step':
      return isNum(m.index) && isStr(m.status) && isStr(m.label) && isNum(m.line);
    case '/diagnostics':
      return isStr(m.level) && isStr(m.message);
  }
}
