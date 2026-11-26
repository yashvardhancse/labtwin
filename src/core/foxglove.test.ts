import * as official from '@foxglove/schemas/jsonschema.js';
import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { EXAMPLES } from './examples.ts';
import { FOXGLOVE_SCHEMAS, foxgloveMessages, frameTransforms } from './foxglove.ts';
import { DEFAULT_MACHINE } from './machine.ts';
import { simulate } from './sim.ts';
import { validateProtocol } from './validate.ts';

const protocol = validateProtocol(EXAMPLES[0]?.source ?? '').protocol;
if (!protocol) throw new Error('example does not validate');
const { log } = simulate(protocol, { seed: 9 });
const messages = foxgloveMessages(log, 1_000_000_000_000n, DEFAULT_MACHINE);

describe('Foxglove export', () => {
  it('vendors the official schemas unchanged', () => {
    expect(FOXGLOVE_SCHEMAS['foxglove.FrameTransforms']).toEqual(official.FrameTransforms);
    expect(FOXGLOVE_SCHEMAS['foxglove.SceneUpdate']).toEqual(official.SceneUpdate);
    expect(FOXGLOVE_SCHEMAS['foxglove.Log']).toEqual(official.Log);
  });

  it.each(['foxglove.FrameTransforms', 'foxglove.SceneUpdate', 'foxglove.Log'] as const)(
    'every %s message validates against the official JSON schema',
    (schemaName) => {
      const validate = new Ajv({ strict: false, allErrors: true }).compile(
        FOXGLOVE_SCHEMAS[schemaName] ?? {},
      );
      const ofType = messages.filter((m) => m.schemaName === schemaName);
      expect(ofType.length).toBeGreaterThan(0);
      for (const m of ofType) {
        const valid = validate(m.msg);
        expect(valid, JSON.stringify(validate.errors?.slice(0, 3))).toBe(true);
      }
    },
  );

  it('chains the frames so the needle tip sits at the axis positions', () => {
    const tf = frameTransforms({ x: 40, y: 25, z: 2 }, 0n) as {
      transforms: {
        parent_frame_id: string;
        child_frame_id: string;
        translation: { x: number; y: number; z: number };
      }[];
    };
    expect(tf.transforms.map((t) => `${t.parent_frame_id}>${t.child_frame_id}`)).toEqual([
      'world>gantry_y',
      'gantry_y>carriage_x',
      'carriage_x>head_z',
    ]);
    const tip = tf.transforms.reduce(
      (p, t) => ({ x: p.x + t.translation.x, y: p.y + t.translation.y, z: p.z + t.translation.z }),
      { x: 0, y: 0, z: 0 },
    );
    expect(tip.x).toBeCloseTo(0.04, 12);
    expect(tip.y).toBeCloseTo(0.025, 12);
    expect(tip.z).toBeCloseTo(0.002, 12);
  });

  it('is sorted by time and shows the droplet in the final scene', () => {
    for (let i = 1; i < messages.length; i++) {
      expect((messages[i]?.logTimeNs ?? 0n) >= (messages[i - 1]?.logTimeNs ?? 0n)).toBe(true);
    }
    const lastScene = messages.filter((m) => m.topic === '/scene').at(-1)?.msg as {
      entities: { id: string; spheres: unknown[] }[];
    };
    expect(lastScene.entities.find((e) => e.id === 'droplets')?.spheres).toHaveLength(1);
  });
});
