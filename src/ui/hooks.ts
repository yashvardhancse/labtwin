import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import { DEFAULT_MACHINE } from '../core/machine.ts';
import type { RunLog } from '../core/runLog.ts';
import { extractDroplets, initialScene, sceneAt, type SceneState } from '../core/scene.ts';
import type { ControllerState, FrameState, TwinController } from './controller.ts';

export const ControllerContext = createContext<TwinController | null>(null);

export function useController(): TwinController {
  const controller = useContext(ControllerContext);
  if (!controller) throw new Error('useController must be used inside <ControllerContext.Provider>');
  return controller;
}

/** Mode, speed, session — changes rarely. */
export function useTwinState(): ControllerState {
  const c = useController();
  return useSyncExternalStore(c.subscribe, c.getState);
}

/** Playhead — changes every animation frame while running. */
export function useFrame(): FrameState {
  const c = useController();
  return useSyncExternalStore(c.subscribeFrame, c.getFrame);
}

/** Machine snapshot at the playhead, derived from the recorded topics. */
export function useScene(): SceneState {
  const { session } = useTwinState();
  const frame = useFrame();
  const log = session?.log;
  // Droplet tracks only change when the log grows (its revision).
  const tracks = useMemo(() => dropletTracks(log, frame.revision), [log, frame.revision]);
  return useMemo(
    () => (log ? sceneAt(log, frame.t, DEFAULT_MACHINE, tracks) : initialScene(DEFAULT_MACHINE)),
    [log, frame.t, tracks],
  );
}

/** `revision` only keys the memo: the log is mutated in place as it grows. */
function dropletTracks(log: RunLog | undefined, revision: number) {
  return log && revision >= 0 ? extractDroplets(log) : [];
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia('(prefers-reduced-motion: reduce)');
      query.addEventListener('change', notify);
      return () => {
        query.removeEventListener('change', notify);
      };
    },
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
}

export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setWidth(Math.round(w));
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

/** `#/` or `#/ros2` — hash routing works on any static host without rewrites. */
export function useHashRoute(): string {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener('hashchange', notify);
      return () => {
        window.removeEventListener('hashchange', notify);
      };
    },
    () => window.location.hash.replace(/^#/, '') || '/',
  );
}
