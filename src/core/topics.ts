import type { AxisName } from './machine.ts';
import type { StepType } from './protocol.ts';

/**
 * Topics and message types — the "ROS 2 interface" of the simulated robot.
 *
 * Field names follow ROS conventions (snake_case, unit suffixes). Each topic
 * has a JSON Schema, written into recordings so tools like Foxglove can
 * introspect the messages. In a ROS 2 system these would be .msg definitions in
 * an interfaces package; see the "How it maps to ROS 2" page.
 */

export interface AxisStateMsg {
  axis: AxisName;
  /** Commanded position from the trajectory generator, mm. */
  cmd_mm: number;
  /** Measured position (encoder), mm. */
  actual_mm: number;
  /** Measured velocity, mm/s. */
  velocity_mm_s: number;
  homed: boolean;
}

export type PumpMode = 'idle' | 'aspirating' | 'dispensing';

export interface PumpStateMsg {
  /** Sample currently held in the syringe, nL. */
  volume_nl: number;
  /** Signed flow: positive while aspirating, negative while dispensing, nL/s. */
  flow_nl_s: number;
  mode: PumpMode;
}

export interface StageTemperatureMsg {
  /** Measured cold-plate temperature, °C. */
  celsius: number;
  /** Controller set-point, °C. */
  target_c: number;
}

/** Mirrors ROS 2 action goal states (action_msgs/GoalStatus). */
export type StepStatus = 'executing' | 'succeeded' | 'aborted' | 'canceled';

export interface ProtocolStepMsg {
  index: number;
  type: StepType;
  status: StepStatus;
  /** 1-based source line in the protocol YAML. */
  line: number;
  label: string;
}

/** Mirrors diagnostic_msgs/DiagnosticStatus levels (OK, WARN, ERROR). */
export type DiagnosticLevel = 'OK' | 'WARN' | 'ERROR';

export interface DiagnosticMsg {
  level: DiagnosticLevel;
  /** Node that raised it, e.g. `protocol_executor`. */
  name: string;
  message: string;
}

export interface TopicMap {
  '/axis/x/state': AxisStateMsg;
  '/axis/y/state': AxisStateMsg;
  '/axis/z/state': AxisStateMsg;
  '/pump/state': PumpStateMsg;
  '/stage/temperature': StageTemperatureMsg;
  '/protocol/step': ProtocolStepMsg;
  '/diagnostics': DiagnosticMsg;
}

export type TopicName = keyof TopicMap;

export const AXIS_TOPIC = {
  x: '/axis/x/state',
  y: '/axis/y/state',
  z: '/axis/z/state',
} as const satisfies Record<AxisName, TopicName>;

export const TOPICS: readonly TopicName[] = [
  '/axis/x/state',
  '/axis/y/state',
  '/axis/z/state',
  '/pump/state',
  '/stage/temperature',
  '/protocol/step',
  '/diagnostics',
];

export function isTopicName(topic: string): topic is TopicName {
  return (TOPICS as readonly string[]).includes(topic);
}

export interface TopicInfo {
  schemaName: string;
  /** Nominal publish rate, Hz (0 = on change). */
  rateHz: number;
  description: string;
  jsonSchema: Record<string, unknown>;
}

const number = (description: string) => ({ type: 'number', description });

const axisSchema = {
  type: 'object',
  title: 'labtwin.AxisState',
  properties: {
    axis: { type: 'string', enum: ['x', 'y', 'z'] },
    cmd_mm: number('Commanded position, mm'),
    actual_mm: number('Measured position, mm'),
    velocity_mm_s: number('Measured velocity, mm/s'),
    homed: { type: 'boolean' },
  },
  required: ['axis', 'cmd_mm', 'actual_mm', 'velocity_mm_s', 'homed'],
};

export const TOPIC_INFO: Record<TopicName, TopicInfo> = {
  '/axis/x/state': {
    schemaName: 'labtwin.AxisState',
    rateHz: 100,
    description: 'X axis: commanded vs measured position and velocity',
    jsonSchema: axisSchema,
  },
  '/axis/y/state': {
    schemaName: 'labtwin.AxisState',
    rateHz: 100,
    description: 'Y axis: commanded vs measured position and velocity',
    jsonSchema: axisSchema,
  },
  '/axis/z/state': {
    schemaName: 'labtwin.AxisState',
    rateHz: 100,
    description: 'Z axis: commanded vs measured position and velocity',
    jsonSchema: axisSchema,
  },
  '/pump/state': {
    schemaName: 'labtwin.PumpState',
    rateHz: 50,
    description: 'Syringe pump volume, flow and mode',
    jsonSchema: {
      type: 'object',
      title: 'labtwin.PumpState',
      properties: {
        volume_nl: number('Sample in the syringe, nL'),
        flow_nl_s: number('Signed flow (+ aspirate, − dispense), nL/s'),
        mode: { type: 'string', enum: ['idle', 'aspirating', 'dispensing'] },
      },
      required: ['volume_nl', 'flow_nl_s', 'mode'],
    },
  },
  '/stage/temperature': {
    schemaName: 'labtwin.StageTemperature',
    rateHz: 10,
    description: 'Cryo-stage temperature and set-point',
    jsonSchema: {
      type: 'object',
      title: 'labtwin.StageTemperature',
      properties: { celsius: number('Measured, °C'), target_c: number('Set-point, °C') },
      required: ['celsius', 'target_c'],
    },
  },
  '/protocol/step': {
    schemaName: 'labtwin.ProtocolStep',
    rateHz: 0,
    description: 'Protocol step transitions (action goal status)',
    jsonSchema: {
      type: 'object',
      title: 'labtwin.ProtocolStep',
      properties: {
        index: { type: 'integer', minimum: 0 },
        type: { type: 'string' },
        status: { type: 'string', enum: ['executing', 'succeeded', 'aborted', 'canceled'] },
        line: { type: 'integer', minimum: 1 },
        label: { type: 'string' },
      },
      required: ['index', 'type', 'status', 'line', 'label'],
    },
  },
  '/diagnostics': {
    schemaName: 'labtwin.Diagnostic',
    rateHz: 0,
    description: 'Warnings and errors raised by the nodes',
    jsonSchema: {
      type: 'object',
      title: 'labtwin.Diagnostic',
      properties: {
        level: { type: 'string', enum: ['OK', 'WARN', 'ERROR'] },
        name: { type: 'string' },
        message: { type: 'string' },
      },
      required: ['level', 'name', 'message'],
    },
  },
};
