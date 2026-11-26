import { setDiagnostics } from '@codemirror/lint';
import { Compartment, EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { Diagnostic } from '../../core/validate.ts';
import { protocolEditorExtensions, setActiveStepLine, toCmDiagnostics } from './extensions.ts';

export interface ProtocolEditorHandle {
  /** Move the cursor to a source range and focus the editor. */
  reveal(from: number, to: number): void;
  setActiveLine(line: number | null): void;
}

interface Props {
  value: string;
  readOnly: boolean;
  diagnostics: readonly Diagnostic[];
  onChange: (value: string) => void;
}

/**
 * CodeMirror 6 wrapper. The editor owns its document; React pushes in
 * replacements (example picked, recording opened), diagnostics and the
 * read-only flag, and hears about edits through `onChange`.
 */
export const ProtocolEditor = forwardRef<ProtocolEditorHandle, Props>(function ProtocolEditor(
  { value, readOnly, diagnostics, onChange },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const readOnlyCompartment = useRef(new Compartment());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Create the view once.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const compartment = readOnlyCompartment.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          protocolEditorExtensions((doc) => {
            onChangeRef.current(doc);
          }),
          compartment.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // The initial value and read-only flag are applied by the effects below on later changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Replace the document when the value changes from outside (examples, recordings).
  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure([
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(setDiagnostics(view.state, toCmDiagnostics(diagnostics, view.state.doc.length)));
  }, [diagnostics, value]);

  useImperativeHandle(
    ref,
    () => ({
      reveal(from, to) {
        const view = viewRef.current;
        if (!view) return;
        const length = view.state.doc.length;
        view.dispatch({
          selection: EditorSelection.range(Math.min(from, length), Math.min(Math.max(from, to), length)),
          effects: EditorView.scrollIntoView(Math.min(from, length), { y: 'center' }),
        });
        view.focus();
      },
      setActiveLine(line) {
        viewRef.current?.dispatch({ effects: setActiveStepLine.of(line) });
      },
    }),
    [],
  );

  return <div className="editor-host" ref={hostRef} />;
});
