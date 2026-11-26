import { EVENT_ID, YAMLException, constructFromEvents, getScalarValue, parseEvents } from 'js-yaml';

/**
 * YAML parsing with source positions.
 *
 * js-yaml 5 exposes its parser as a flat event stream with source offsets.
 * We construct the JS value from those events and, in the same pass, index the
 * source span of every node by its path (e.g. `steps/3/move/x`), so validation
 * errors can point at the exact token — not just "somewhere in step 4".
 */

export type YamlPath = readonly (string | number)[];

export interface Span {
  /** Offset of the first character (0-based, UTF-16 code units, like JS strings). */
  from: number;
  /** Offset one past the last character. */
  to: number;
}

export interface NodeLocation {
  value: Span;
  /** For mapping values: the span of the key that introduced the value. */
  key?: Span;
}

export interface YamlDocument {
  value: unknown;
  locate(path: YamlPath): NodeLocation | undefined;
}

export type YamlParseResult =
  { ok: true; doc: YamlDocument } | { ok: false; message: string; offset: number };

const pathKey = (path: YamlPath): string => path.join('\u0001');

export function parseYaml(source: string): YamlParseResult {
  let events: ReturnType<typeof parseEvents>;
  let documents: unknown[];
  try {
    events = parseEvents(source, { maxDepth: 32 });
    documents = constructFromEvents(events, { source, maxAliases: 64 });
  } catch (err) {
    if (err instanceof YAMLException) {
      return { ok: false, message: friendlyYamlError(err.reason), offset: err.mark?.position ?? 0 };
    }
    return { ok: false, message: err instanceof Error ? err.message : String(err), offset: 0 };
  }
  if (documents.length > 1) {
    const second = source.search(/^---/m);
    return {
      ok: false,
      message: 'Only one protocol per file: remove the second `---` document.',
      offset: Math.max(0, second),
    };
  }
  const locations = indexLocations(events, source);
  return {
    ok: true,
    doc: { value: documents[0] ?? null, locate: (path) => locations.get(pathKey(path)) },
  };
}

interface Frame {
  kind: 'doc' | 'map' | 'seq';
  path: (string | number)[];
  start: number;
  end: number;
  key: Span | undefined;
  /** Sequences: index of the next item. */
  nextIndex: number;
  /** Mappings: the next node is a key (true) or a value (false). */
  expectKey: boolean;
  pendingKey: { name: string; span: Span } | null;
  /** Inside a complex (non-scalar) key — not addressable by path. */
  ignored: boolean;
}

function indexLocations(events: ReturnType<typeof parseEvents>, source: string): Map<string, NodeLocation> {
  const out = new Map<string, NodeLocation>();
  const stack: Frame[] = [];
  const frame = (kind: Frame['kind'], path: (string | number)[], start: number, key?: Span): Frame => ({
    kind,
    path,
    start,
    end: start,
    key,
    nextIndex: 0,
    expectKey: true,
    pendingKey: null,
    ignored: false,
  });
  const extend = (end: number) => {
    for (const f of stack) f.end = Math.max(f.end, end);
  };

  for (const event of events) {
    if (event.type === EVENT_ID.DOCUMENT) {
      stack.push(frame('doc', [], 0));
      continue;
    }
    if (event.type === EVENT_ID.POP) {
      const done = stack.pop();
      if (done && done.kind !== 'doc' && !done.ignored) {
        out.set(pathKey(done.path), {
          value: { from: done.start, to: Math.max(done.end, done.start + 1) },
          ...(done.key ? { key: done.key } : {}),
        });
      }
      continue;
    }

    const parent = stack[stack.length - 1];
    if (!parent) continue;

    // Where does this node start and end in the source?
    let start: number;
    let end: number;
    if (event.type === EVENT_ID.SCALAR) {
      start = event.valueStart >= 0 ? event.valueStart : parent.end;
      end = event.valueEnd >= 0 ? event.valueEnd : start;
    } else if (event.type === EVENT_ID.ALIAS) {
      start = Math.max(0, event.anchorStart - 1);
      end = event.anchorEnd;
    } else {
      start = event.start;
      end = event.start;
    }

    // What role does it play in its parent?
    let path: (string | number)[] | null;
    let key: Span | undefined;
    if (parent.ignored) {
      path = null;
    } else if (parent.kind === 'doc') {
      path = [];
    } else if (parent.kind === 'seq') {
      path = [...parent.path, parent.nextIndex++];
    } else if (parent.expectKey) {
      parent.expectKey = false;
      parent.pendingKey =
        event.type === EVENT_ID.SCALAR
          ? { name: getScalarValue(source, event), span: { from: start, to: end } }
          : { name: '\u0000', span: { from: start, to: end } };
      path = null; // keys are recorded together with their value
    } else {
      parent.expectKey = true;
      path = [...parent.path, parent.pendingKey?.name ?? '\u0000'];
      key = parent.pendingKey?.span;
      parent.pendingKey = null;
    }

    if (event.type === EVENT_ID.MAPPING || event.type === EVENT_ID.SEQUENCE) {
      const child = frame(event.type === EVENT_ID.MAPPING ? 'map' : 'seq', path ?? [], start, key);
      child.ignored = path === null;
      stack.push(child);
    } else if (path !== null) {
      out.set(pathKey(path), { value: { from: start, to: end }, ...(key ? { key } : {}) });
    }
    extend(end);
  }
  return out;
}

/** Turn js-yaml's terse parser messages into advice a scientist can act on. */
export function friendlyYamlError(reason: string): string {
  const r = reason.toLowerCase();
  if (r.includes('tab')) return 'YAML indentation must use spaces, not tabs.';
  if (r.includes('duplicate') || r.includes('duplicated'))
    return 'The same key appears twice in one mapping. Remove or rename one of them.';
  if (r.includes('missed comma') || r.includes('comma'))
    return 'Missing comma between fields inside `{ … }`. Separate fields with commas, e.g. `{ x: 10, y: 20 }`.';
  if (r.includes('end of the stream') || r.includes('flow collection'))
    return 'A `{` or `[` is never closed. Add the matching `}` or `]`.';
  if (r.includes('indentation'))
    return 'Indentation does not line up with the surrounding lines. Check the leading spaces here, and that any `{` on the line above is closed.';
  if (r.includes('colon') || r.includes('mapping'))
    return 'This line is not a valid `key: value` pair. Check for a missing `:` or a stray character.';
  const text = reason.trim();
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** Offsets of the start of every line, for offset → line/column conversion. */
export function lineStarts(source: string): number[] {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line and column of an offset. */
export function lineColumn(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (starts[lo] ?? 0) + 1 };
}
