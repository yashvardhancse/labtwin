import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { DEFAULT_EXAMPLE, EXAMPLES } from '../core/examples.ts';
import { DEFAULT_SEED } from '../core/sim.ts';
import { validateProtocol } from '../core/validate.ts';
import { ChartsPanel } from './charts/ChartsPanel.tsx';
import { RecordingError } from './controller.ts';
import { bytes as formatBytes } from './format.ts';
import { useController, usePrefersReducedMotion, useTwinState } from './hooks.ts';
import { CloseIcon, ErrorIcon, CheckIcon } from './icons.tsx';
import { ProtocolPanel } from './ProtocolPanel.tsx';
import { RunReport } from './RunReport.tsx';
import { Transport } from './Transport.tsx';
import { Viewport } from './Viewport.tsx';

interface Notice {
  tone: 'error' | 'info';
  text: string;
}

/** The main instrument screen. */
export function TwinPage({ hidden }: { hidden: boolean }) {
  const controller = useController();
  const { session } = useTwinState();
  const reducedMotion = usePrefersReducedMotion();
  const [draft, setDraft] = useState(DEFAULT_EXAMPLE.source);
  const [seed, setSeed] = useState(DEFAULT_SEED);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [dragging, setDragging] = useState(false);

  const viewingFile = session?.source === 'file';
  const doc = viewingFile ? session.protocolYaml : draft;
  const validation = useMemo(() => validateProtocol(doc), [doc]);
  const plannedPath = useMemo(() => validation.path.map((w) => w.position), [validation]);

  // First visit: play a short demo so the page is alive immediately
  // (skipped for people who prefer reduced motion — they get a "Run demo" button).
  const autoplayed = useRef(false);
  useEffect(() => {
    if (autoplayed.current) return;
    autoplayed.current = true;
    if (reducedMotion) return;
    const protocol = validateProtocol(DEFAULT_EXAMPLE.source).protocol;
    if (protocol) controller.startRun(protocol, DEFAULT_SEED, 2);
  }, [controller, reducedMotion]);

  const run = () => {
    if (!validation.protocol) return;
    if (viewingFile) setDraft(doc);
    setNotice(null);
    controller.startRun(validation.protocol, seed);
  };

  const download = async () => {
    try {
      const { bytes, fileName } = await controller.exportRecording();
      const url = URL.createObjectURL(
        new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }),
      );
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fileName;
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 10_000);
      setNotice({
        tone: 'info',
        text: `Saved ${fileName} (${formatBytes(bytes.length)}). Open it in Foxglove, or load it back here with "Open recording".`,
      });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const openFile = async (file: File) => {
    try {
      if (!file.name.toLowerCase().endsWith('.mcap')) {
        throw new RecordingError(
          `"${file.name}" is not an .mcap file. Choose a recording exported by LabTwin.`,
        );
      }
      controller.openRecording(new Uint8Array(await file.arrayBuffer()), file.name);
      const opened = controller.getState().session;
      if (opened?.seed !== null && opened?.seed !== undefined) setSeed(opened.seed);
      setNotice(null);
    } catch (err) {
      const text =
        err instanceof RecordingError ? err.message : `Could not open ${file.name}: ${String(err)}`;
      setNotice({ tone: 'error', text });
    }
  };

  const replayViaMcap = async () => {
    try {
      await controller.replayViaMcap();
      setNotice({
        tone: 'info',
        text: 'Replaying the run decoded from its MCAP bytes: the same file you would download.',
      });
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void openFile(file);
  };

  return (
    <main
      id="main"
      className="twin"
      hidden={hidden}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <div className="stage">
        <Viewport plannedPath={plannedPath} onRunDemo={run} canRun={validation.protocol !== null} />
        <Transport
          canRun={validation.protocol !== null}
          errorCount={validation.errorCount}
          onRun={run}
          onDownload={() => void download()}
          onOpenFile={(file) => void openFile(file)}
          seed={seed}
          onSeedChange={setSeed}
        />
        {notice && (
          <div className={`notice notice-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
            {notice.tone === 'error' ? <ErrorIcon /> : <CheckIcon />}
            <span>{notice.text}</span>
            <button
              type="button"
              className="icon-btn small"
              onClick={() => {
                setNotice(null);
              }}
              aria-label="Dismiss message"
            >
              <CloseIcon />
            </button>
          </div>
        )}
        <div className="lower">
          <ChartsPanel />
          <RunReport onReplayViaMcap={() => void replayViaMcap()} />
        </div>
      </div>

      <ProtocolPanel
        doc={doc}
        validation={validation}
        onChange={setDraft}
        onPickExample={(id) => {
          const example = EXAMPLES.find((e) => e.id === id);
          if (example) setDraft(example.source);
        }}
        onCloseRecording={() => {
          controller.closeRecording();
        }}
      />

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          Drop an .mcap recording to replay it
        </div>
      )}
    </main>
  );
}
