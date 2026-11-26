/** Example protocols offered in the editor's menu. */

export interface ExampleProtocol {
  id: string;
  title: string;
  description: string;
  source: string;
}

/** The protocol loaded on first visit and used for the auto-played demo run. */
export const DEFAULT_EXAMPLE: ExampleProtocol = {
  id: 'standard',
  title: 'Grid prep – standard',
  description: 'Cool the stage in the background, load sample, write one droplet on grid G1.',
  source: `name: Grid prep – standard
steps:
  - home: {}
  # Cool in the background while the head loads sample.
  - cool_stage: { target_c: -170, wait: false }
  - move: { x: 100, y: 60, z: 20, speed: 60 }
  - move: { z: 4, speed: 15 }
  - aspirate: { volume_nl: 4 }
  - move: { z: 30, speed: 30 }
  # Over grid G1, then a slow final approach.
  - move: { x: 40, y: 25, z: 8, speed: 60 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 3 }
  - wait: { ms: 500 }
  - move: { z: 30 }
`,
};

export const EXAMPLES: readonly ExampleProtocol[] = [
  DEFAULT_EXAMPLE,
  {
    id: 'series',
    title: 'Four-grid series',
    description: 'Cool first (blocking), then write 2 nL on each of the four grids.',
    source: `name: Four-grid series
steps:
  - home: {}
  # Blocking: waits here until the stage is cold.
  - cool_stage: { target_c: -175 }
  - move: { x: 100, y: 60, z: 20, speed: 80 }
  - move: { z: 4, speed: 15 }
  - aspirate: { volume_nl: 9, rate_nl_s: 4 }
  - move: { z: 20, speed: 30 }
  # G1
  - move: { x: 40, y: 25, z: 6, speed: 80 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 6, speed: 20 }
  # G2
  - move: { x: 50, speed: 40 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 6, speed: 20 }
  # G3
  - move: { x: 60, speed: 40 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 6, speed: 20 }
  # G4
  - move: { x: 70, speed: 40 }
  - move: { z: 2, speed: 5 }
  - dispense: { volume_nl: 2 }
  - move: { z: 30, speed: 30 }
`,
  },
  {
    id: 'quick',
    title: 'Quick dispense (has a warning)',
    description: 'Runs, but the validator warns that it aspirates outside the sample vial.',
    source: `name: Quick dispense
steps:
  - home: {}
  - cool_stage: { target_c: -170 }
  - move: { x: 40, y: 25, z: 10, speed: 50 }
  - aspirate: { volume_nl: 4 }
  - move: { z: 2, speed: 10 }
  - dispense: { volume_nl: 3 }
  - wait: { ms: 500 }
  - move: { z: 30 }
`,
  },
  {
    id: 'broken',
    title: 'Broken protocol (try fixing it)',
    description: 'Eight planted mistakes for the validator to catch.',
    source: `name: Broken protocol – try fixing it
steps:
  - move: { x: 40, y: 25, z: 10 }
  - home: {}
  - move: { x: 140, y: 25, z: 10, speed: 50 }
  - aspirate: { volume_nl: 4 }
  - dispence: { volume_nl: 3 }
  - dispense: { volume_nl: 6 }
  - move: { z: 2, speed: 250 }
  - wait: { ms: half a second }
  - cool_stage: { target_c: -250 }
`,
  },
];
