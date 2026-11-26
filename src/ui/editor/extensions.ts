import {
  autocompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { yaml } from '@codemirror/lang-yaml';
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { lintGutter, type Diagnostic as CmDiagnostic } from '@codemirror/lint';
import { RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration,
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { DEFAULT_MACHINE } from '../../core/machine.ts';
import { fmt, isStepType, stepSpecs, STEP_TYPES } from '../../core/protocol.ts';
import type { Diagnostic } from '../../core/validate.ts';

/** Diagnostics from the core validator, in CodeMirror's shape. */
export function toCmDiagnostics(diagnostics: readonly Diagnostic[], docLength: number): CmDiagnostic[] {
  return diagnostics.map((d) => {
    const from = Math.min(d.from, docLength);
    return {
      from,
      to: Math.min(Math.max(d.to, from), docLength),
      severity: d.severity,
      message: d.hint ? `${d.message}\n${d.hint}` : d.message,
      source: d.code,
    };
  });
}

// ── Highlight of the step that is executing at the playhead ─────────
export const setActiveStepLine = StateEffect.define<number | null>();
const activeStepDecoration = Decoration.line({ class: 'cm-activeStep' });

export const activeStepField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    let next = decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setActiveStepLine)) continue;
      const line = effect.value;
      next =
        line !== null && line >= 1 && line <= tr.state.doc.lines
          ? Decoration.set([activeStepDecoration.range(tr.state.doc.line(line).from)])
          : Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

// ── Hanging indent: wrapped lines continue under their step, not at column 0 ──
function indentDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = view.state.doc.lineAt(pos);
      const match = /^(\s*)(- )?/.exec(line.text);
      const indent = (match?.[1]?.length ?? 0) + (match?.[2] ? 2 : 0) + 2;
      builder.add(
        line.from,
        line.from,
        Decoration.line({
          attributes: { style: `padding-left: calc(${indent}ch + 8px); text-indent: -${indent}ch` },
        }),
      );
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

const hangingIndent = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = indentDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = indentDecorations(update.view);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ── Autocompletion from the protocol spec ───────────────────────────
const specs = stepSpecs(DEFAULT_MACHINE);

const stepCompletions: Completion[] = STEP_TYPES.map((type) => {
  const spec = specs[type];
  const fields = spec.fields.filter((f) => f.required || ['x', 'y', 'z'].includes(f.name));
  const body = fields.map((f) => `${f.name}: \${${String(f.example ?? f.defaultValue ?? '')}}`).join(', ');
  return snippetCompletion(fields.length > 0 ? `${type}: { ${body} }` : `${type}: {}`, {
    label: type,
    type: 'keyword',
    detail: 'step',
    info: spec.summary,
  });
});

function protocolCompletions(context: CompletionContext) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);

  // `  - mo|` → a step type.
  const stepStart = /^\s*-\s+([a-z_]*)$/.exec(before);
  if (stepStart) {
    return {
      from: context.pos - (stepStart[1]?.length ?? 0),
      options: stepCompletions,
      validFor: /^[a-z_]*$/,
    };
  }

  // `  - move: { x: 10, sp|` → a field of that step.
  const inFields = /^\s*-\s+([a-z_]+):\s*\{([^}]*)$/.exec(before);
  const type = inFields?.[1];
  if (inFields && type && isStepType(type)) {
    const word = /([a-z_]*)$/.exec(before)?.[1] ?? '';
    const used = new Set([...(inFields[2] ?? '').matchAll(/([a-z_]+)\s*:/g)].map((m) => m[1]));
    const options: Completion[] = specs[type].fields
      .filter((f) => !used.has(f.name))
      .map((f) => ({
        label: f.name,
        type: 'property',
        apply: `${f.name}: `,
        detail:
          f.kind === 'boolean'
            ? 'true / false'
            : `${f.unit ?? ''}${f.min !== undefined && f.max !== undefined ? `, ${fmt(f.min)} to ${fmt(f.max)}` : ''}`,
        info: f.doc + (f.required ? ' (required)' : ''),
      }));
    return { from: context.pos - word.length, options, validFor: /^[a-z_]*$/ };
  }
  return null;
}

// ── Look ────────────────────────────────────────────────────────────
const highlight = HighlightStyle.define([
  { tag: tags.definition(tags.propertyName), color: 'var(--code-key)', fontWeight: '500' },
  { tag: [tags.content, tags.string], color: 'var(--code-value)' },
  { tag: tags.lineComment, color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: [tags.separator, tags.brace, tags.squareBracket, tags.punctuation], color: 'var(--code-punct)' },
  { tag: [tags.keyword, tags.meta, tags.labelName, tags.typeName], color: 'var(--code-key)' },
]);

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px', backgroundColor: 'var(--panel)', color: 'var(--ink)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
  '.cm-content': { padding: '10px 0', caretColor: 'var(--ink)' },
  '.cm-line': { padding: '0 12px 0 8px' },
  '.cm-gutters': {
    backgroundColor: 'var(--panel)',
    color: 'var(--ink-3)',
    border: 'none',
    borderRight: '1px solid var(--line-soft)',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 6px 0 10px', minWidth: '28px' },
  '.cm-activeLine': { backgroundColor: 'rgba(18, 26, 34, 0.035)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink)' },
  '.cm-activeStep': { backgroundColor: 'var(--cryo-tint)', boxShadow: 'inset 3px 0 0 var(--cryo)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: 'rgba(10, 118, 168, 0.18)',
  },
  '.cm-cursor': { borderLeftColor: 'var(--ink)' },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--error)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy var(--warn-icon)',
    textDecorationSkipInk: 'none',
    textUnderlineOffset: '3px',
  },
  '.cm-tooltip': {
    border: '1px solid var(--line)',
    backgroundColor: 'var(--panel)',
    borderRadius: '6px',
    boxShadow: '0 6px 20px rgba(18,26,34,0.12)',
    fontFamily: 'var(--font-sans)',
  },
  '.cm-diagnostic': { padding: '6px 10px', fontSize: '13px', whiteSpace: 'pre-wrap', maxWidth: '380px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--error)' },
  '.cm-diagnostic-warning': { borderLeft: '3px solid var(--warn-icon)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12.5px' },
  '.cm-completionDetail': { fontFamily: 'var(--font-sans)', color: 'var(--ink-3)', marginLeft: '8px' },
  '.cm-completionInfo': { fontFamily: 'var(--font-sans)', fontSize: '12.5px', maxWidth: '260px' },
});

export function protocolEditorExtensions(onChange: (doc: string) => void): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    yaml(),
    syntaxHighlighting(highlight),
    lintGutter(),
    activeStepField,
    autocompletion({ override: [protocolCompletions], icons: false }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    hangingIndent,
    theme,
    EditorView.contentAttributes.of({ 'aria-label': 'Protocol YAML editor', spellcheck: 'false' }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString());
    }),
  ];
}
