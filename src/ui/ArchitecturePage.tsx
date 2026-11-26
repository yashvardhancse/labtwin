interface BoxProps {
  x: number;
  y: number;
  w: number;
  h?: number;
  title: string;
  sub?: string;
  mirror?: string;
  tone?: 'default' | 'file' | 'external';
}

function Box({ x, y, w, h = 76, title, sub, mirror, tone = 'default' }: BoxProps) {
  return (
    <g className={`arch-box tone-${tone}`}>
      <rect x={x} y={y} width={w} height={h} rx={8} />
      <text className="arch-title" x={x + 14} y={y + 25}>
        {title}
      </text>
      {sub && (
        <text className="arch-sub" x={x + 14} y={y + 45}>
          {sub}
        </text>
      )}
      {mirror && (
        <text className="arch-mirror" x={x + 14} y={y + 64}>
          {mirror}
        </text>
      )}
    </g>
  );
}

function Arrow({ d, label, lx, ly }: { d: string; label?: string; lx?: number; ly?: number }) {
  return (
    <g>
      <path className="arch-arrow" d={d} markerEnd="url(#arch-arrowhead)" />
      {label && (
        <text className="arch-label" x={lx} y={ly}>
          {label}
        </text>
      )}
    </g>
  );
}

const TOPICS = [
  ['/axis/{x,y,z}/state', '100 Hz'],
  ['/pump/state', '50 Hz'],
  ['/stage/temperature', '10 Hz'],
  ['/protocol/step', 'on change'],
  ['/diagnostics', 'on change'],
] as const;

function ArchitectureDiagram() {
  return (
    <svg
      className="arch-diagram"
      viewBox="0 0 960 600"
      role="img"
      aria-labelledby="arch-diagram-title arch-diagram-desc"
    >
      <title id="arch-diagram-title">LabTwin architecture and its ROS 2 counterparts</title>
      <desc id="arch-diagram-desc">
        A protocol in YAML is validated, then executed by the protocol executor node, which sends an action
        goal to the gantry driver and service calls to the pump driver and stage controller. All nodes publish
        topics on a bus. A recorder writes the topics to an MCAP file, together with Foxglove topics from an
        adapter. The replay reader loads the file and the 3D view and charts render from topics only; Foxglove
        can open the same file.
      </desc>
      <defs>
        <marker
          id="arch-arrowhead"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0 10 5 0 10z" className="arch-arrowhead" />
        </marker>
      </defs>

      <Box
        x={16}
        y={16}
        w={200}
        title="Protocol (YAML)"
        sub="written by scientists"
        mirror="a sequence of goals"
      />
      <Box
        x={264}
        y={16}
        w={212}
        title="Validator"
        sub="fields, limits, static dry run"
        mirror="pre-flight checks"
      />
      <Box
        x={524}
        y={16}
        w={236}
        title="protocol_executor"
        sub="runs steps, re-checks at run time"
        mirror="ROS 2: action client node"
      />
      <Arrow d="M216 54H262" />
      <Arrow d="M476 54H522" label="valid" lx={482} ly={46} />

      <Box
        x={300}
        y={150}
        w={212}
        title="gantry_driver"
        sub="S-curve + 1 kHz cascade"
        mirror="ROS 2: action server"
      />
      <Box x={530} y={150} w={190} title="pump_driver" sub="aspirate, dispense" mirror="ROS 2: services" />
      <Box
        x={738}
        y={150}
        w={206}
        title="stage_controller"
        sub="exponential cooling"
        mirror="ROS 2: service + timer"
      />
      <Arrow d="M584 92L452 148" label="action /gantry/move" lx={392} ly={118} />
      <Arrow d="M642 92V148" label="service" lx={650} ly={126} />
      <Arrow d="M700 92L820 148" label="service" lx={772} ly={118} />

      <g className="arch-box tone-bus">
        <rect x={16} y={262} width={928} height={60} rx={8} />
        <text className="arch-title" x={30} y={287}>
          Topics
        </text>
        <text className="arch-mirror" x={30} y={308}>
          ROS 2: topics over DDS
        </text>
        {TOPICS.map(([topic, rate], i) => (
          <text key={topic} className="arch-topic" x={190 + i * 152} y={290}>
            {topic}
            <tspan className="arch-rate" x={190 + i * 152} dy={17}>
              {rate}
            </tspan>
          </text>
        ))}
      </g>
      <Arrow d="M406 226V260" />
      <Arrow d="M625 226V260" />
      <Arrow d="M841 226V260" />

      <Box x={16} y={372} w={206} title="Recorder" sub="RunLog.record(bus)" mirror="ros2 bag record" />
      <Box
        x={262}
        y={372}
        w={222}
        title=".mcap file"
        sub="JSON + schema, protocol, metadata"
        mirror="rosbag2 MCAP storage"
        tone="file"
      />
      <Box x={524} y={372} w={196} title="Replay" sub="stream reader, playhead" mirror="ros2 bag play" />
      <Box
        x={760}
        y={372}
        w={184}
        title="3D view, charts"
        sub="render from topics only"
        mirror="RViz or Foxglove + URDF"
      />
      <Arrow d="M119 324V370" />
      <Arrow d="M222 412H260" />
      <Arrow d="M484 412H522" />
      <Arrow d="M720 412H758" />
      <Arrow d="M852 324V370" label="live" lx={860} ly={352} />

      <Box
        x={262}
        y={500}
        w={222}
        title="Foxglove adapter"
        sub="/tf, /scene, /log"
        mirror="robot_state_publisher"
      />
      <Box
        x={524}
        y={500}
        w={196}
        title="Foxglove"
        sub="3D, plot and log panels"
        mirror="opens the same file"
        tone="external"
      />
      <Arrow d="M119 450V538H260" />
      <Arrow d="M373 498V452" />
      <Arrow d="M468 452L548 498" />
    </svg>
  );
}

const MAPPING: [string, string, string][] = [
  [
    'Bus: typed publish/subscribe on named topics',
    'Topics (rclpy publishers and subscriptions over DDS)',
    'src/core/bus.ts',
  ],
  [
    'Message types with a JSON Schema each',
    '.msg definitions in an interfaces package',
    'src/core/topics.ts',
  ],
  [
    'gantry_driver.sendGoal() with executing / succeeded / aborted',
    'Actions and action_msgs/GoalStatus',
    'src/core/nodes/gantry.ts',
  ],
  [
    'pump_driver.call(), stage_controller.setTarget()',
    'Services (request and response)',
    'src/core/nodes/pump.ts, stage.ts',
  ],
  [
    'protocol_executor',
    'A client node that sequences goals (often a behaviour tree)',
    'src/core/nodes/executor.ts',
  ],
  ['Fixed 10 ms tick, messages stamped with simulation time', 'use_sim_time and /clock', 'src/core/sim.ts'],
  ['/diagnostics with OK, WARN and ERROR', 'diagnostic_msgs/DiagnosticStatus', 'src/core/topics.ts'],
  ['RunLog.record(bus)', 'ros2 bag record -s mcap', 'src/core/runLog.ts'],
  ['writeRecording() and readRecording()', 'rosbag2_storage_mcap and ros2 bag play', 'src/core/mcap.ts'],
  [
    'machineGeometry(): links joined by prismatic axes',
    'URDF links and prismatic joints',
    'src/core/geometry.ts',
  ],
  ['/tf computed from the axis states', 'robot_state_publisher from joint_states', 'src/core/foxglove.ts'],
];

const MSG_SKETCH = `# labtwin_msgs/msg/AxisState.msg
string  axis            # "x", "y" or "z"
float64 cmd_mm          # commanded position
float64 actual_mm       # measured position
float64 velocity_mm_s
bool    homed

# labtwin_msgs/action/MoveTo.action
float64[3] target_mm    # NaN keeps an axis where it is
float64    speed_mm_s
---
bool       success
string     message
---
float64[3] position_mm  # feedback while moving

# labtwin_msgs/srv/Dispense.srv
float64 volume_nl
float64 rate_nl_s
---
bool    accepted
string  reason`;

/** "How it maps to ROS 2": architecture diagram, concept mapping, interface sketch, roadmap. */
export function ArchitecturePage() {
  return (
    <main id="main" className="arch-page">
      <article className="arch-content">
        <header className="arch-header">
          <p className="eyebrow">Architecture</p>
          <h1>How it maps to ROS 2</h1>
          <p className="lede">
            LabTwin runs entirely in your browser, but it is structured like a ROS 2 system: nodes that own
            one piece of hardware, typed topics, action-style goals for motion and service calls for the pump
            and the stage. Every run is recorded as MCAP, the format rosbag2 uses, and the UI only ever
            renders from those recorded topics.
          </p>
        </header>

        <div className="arch-figure">
          <ArchitectureDiagram />
        </div>

        <section>
          <h2>Concept by concept</h2>
          <div className="table-wrap">
            <table className="mapping">
              <thead>
                <tr>
                  <th scope="col">In LabTwin</th>
                  <th scope="col">In a ROS 2 system</th>
                  <th scope="col">Code</th>
                </tr>
              </thead>
              <tbody>
                {MAPPING.map(([here, ros, code]) => (
                  <tr key={here}>
                    <td>{here}</td>
                    <td>{ros}</td>
                    <td>
                      <code>{code}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="two-col">
          <div>
            <h2>Design decisions</h2>
            <ul className="plain-list">
              <li>
                <strong>Render from topics only.</strong> The 3D view, charts and report read a time-indexed
                log of messages, never simulator internals, so a live run and a replayed file take the same
                code path.
              </li>
              <li>
                <strong>Deterministic simulation.</strong> A fixed 10 ms tick, a fixed node order and seeded
                noise (integer PRNG, no transcendental functions) give bit-identical runs for the same seed.
              </li>
              <li>
                <strong>Jerk-limited motion, cascaded control.</strong> Moves are coordinated S-curve profiles
                (bounded velocity, acceleration and jerk); each axis runs a P/PI cascade with velocity and
                acceleration feed-forward and anti-windup, over a first-order current loop.
              </li>
              <li>
                <strong>Validate twice.</strong> The validator catches mistakes before anything moves; the
                executor re-checks preconditions at run time, as a real controller must.
              </li>
              <li>
                <strong>One machine description.</strong> The same link and primitive list builds the three.js
                scene and the Foxglove <code>/scene</code>, the way a URDF feeds both RViz and the robot.
              </li>
            </ul>
          </div>
          <div>
            <h2>Interface sketch</h2>
            <p className="muted">
              How these interfaces would be declared in a ROS 2 package. A sketch for the next step, not part
              of this repository yet.
            </p>
            <pre className="code-block">
              <code>{MSG_SKETCH}</code>
            </pre>
          </div>
        </section>

        <section>
          <h2>Roadmap</h2>
          <p className="muted">Next steps. None of these exist yet.</p>
          <ol className="roadmap">
            <li>
              <strong>Real ROS 2 nodes.</strong> rclpy nodes (rclcpp for the drive bridge) publishing these
              same topics, built and tested in containers.
            </li>
            <li>
              <strong>rosbag2 interop.</strong> Replay bags recorded with <code>ros2 bag record -s mcap</code>{' '}
              here, which needs a CDR decoder in the browser.
            </li>
            <li>
              <strong>Foxglove bridge.</strong> Connect the web view to a live robot through the
              foxglove_bridge WebSocket.
            </li>
            <li>
              <strong>URDF export.</strong> Generate URDF/xacro from the machine description.
            </li>
            <li>
              <strong>Camera node.</strong> Publish the tip camera as sensor_msgs/CompressedImage.
            </li>
          </ol>
        </section>
      </article>
    </main>
  );
}
