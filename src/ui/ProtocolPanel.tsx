import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { EXAMPLES } from '../core/examples.ts';
import type { Diagnostic, ValidationResult } from '../core/validate.ts';
import { ProtocolEditor, type ProtocolEditorHandle } from './editor/ProtocolEditor.tsx';
import { plural } from './format.ts';
import { useScene, useTwinState } from './hooks.ts';
import { CheckIcon, CloseIcon, ErrorIcon, WarningIcon } from './icons.tsx';

interface Props {
  doc: string;
  validation: ValidationResult;
  onChange: (doc: string) => void;
  onPickExample: (id: string) => void;
  onCloseRecording: () => void;
}

/** Left column: example picker, YAML editor with inline validation, problems list. */
export function ProtocolPanel({ doc, validation, onChange, onPickExample, onCloseRecording }: Props) {
  const { mode, session } = useTwinState();
  const editorRef = useRef<ProtocolEditorHandle>(null);
  const viewingFile = session?.source === 'file';
  const readOnly = viewingFile || mode === 'live';
  const selected = EXAMPLES.find((e) => e.source === doc)?.id ?? 'custom';

  return (
    <section className="protocol-panel" aria-labelledby="protocol-title">
      <div className="panel-head">
        <h2 id="protocol-title" className="panel-title">
          Protocol
        </h2>
        <label className="example-picker">
          <span className="sr-only">Load an example protocol</span>
          <select
            value={viewingFile ? 'custom' : selected}
            disabled={readOnly}
            onChange={(e) => {
              onPickExample(e.target.value);
            }}
          >
            <option value="custom" disabled>
              {viewingFile ? 'From recording' : 'Edited protocol'}
            </option>
            {EXAMPLES.map((example) => (
              <option key={example.id} value={example.id}>
                {example.title}
              </option>
            ))}
          </select>
        </label>
      </div>

      {viewingFile && (
        <div className="banner banner-info">
          <span>
            Read-only: the protocol stored in <strong>{session.fileName}</strong>.
          </span>
          <button type="button" className="link-btn" onClick={onCloseRecording}>
            <CloseIcon /> Close recording
          </button>
        </div>
      )}
      {mode === 'live' && !viewingFile && (
        <div className="banner banner-info">Locked while the protocol runs. Stop the run to edit.</div>
      )}

      <div className="editor-frame">
        <ProtocolEditor
          ref={editorRef}
          value={doc}
          readOnly={readOnly}
          diagnostics={validation.diagnostics}
          onChange={onChange}
        />
        <ActiveStepSync editor={editorRef} />
      </div>

      <ProblemsList
        validation={validation}
        onReveal={(d) => {
          editorRef.current?.reveal(d.from, d.to);
        }}
      />
    </section>
  );
}

/** Highlights the source line of the step executing at the playhead. */
function ActiveStepSync({ editor }: { editor: RefObject<ProtocolEditorHandle | null> }) {
  const scene = useScene();
  const line = scene.step?.status === 'executing' ? scene.step.line : null;
  useEffect(() => {
    editor.current?.setActiveLine(line);
  }, [editor, line]);
  return null;
}

function ProblemsList({
  validation,
  onReveal,
}: {
  validation: ValidationResult;
  onReveal: (d: Diagnostic) => void;
}) {
  const { errorCount, warningCount, diagnostics } = validation;
  return (
    <div className="problems" aria-live="polite">
      <div className="problems-head">
        {diagnostics.length === 0 ? (
          <span className="problems-ok">
            <CheckIcon /> No problems. Ready to run.
          </span>
        ) : (
          <>
            <span className="panel-title">Problems</span>
            {errorCount > 0 && <span className="count count-error">{plural(errorCount, 'error')}</span>}
            {warningCount > 0 && (
              <span className="count count-warning">{plural(warningCount, 'warning')}</span>
            )}
          </>
        )}
      </div>
      {diagnostics.length > 0 && (
        <ul className="problem-list">
          {diagnostics.map((d, i) => (
            <li key={`${d.from}-${d.code}-${i}`}>
              <button
                type="button"
                className={`problem is-${d.severity}`}
                onClick={() => {
                  onReveal(d);
                }}
              >
                {d.severity === 'error' ? (
                  <ErrorIcon className="problem-icon" />
                ) : (
                  <WarningIcon className="problem-icon" />
                )}
                <span className="problem-text">
                  <span className="problem-line">Line {d.line}</span>
                  <span className="problem-message">{withCode(d.message)}</span>
                  {d.hint && <span className="problem-hint">{withCode(d.hint)}</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Render `backticked` fragments of validator messages as code. */
function withCode(text: string): ReactNode[] {
  return text.split('`').map((part, i) => (i % 2 === 1 ? <code key={i}>{part}</code> : part));
}
