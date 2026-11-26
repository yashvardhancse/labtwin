import type { TopicMap, TopicName } from './topics.ts';

/**
 * Minimal in-process publish/subscribe bus — the stand-in for the ROS 2 graph.
 * Nodes publish typed messages on named topics; every message is stamped with
 * the simulation clock (not wall time), so recordings are reproducible.
 */

export interface Envelope<K extends TopicName = TopicName> {
  topic: K;
  /** Simulation time, ms since the start of the run. */
  t: number;
  msg: TopicMap[K];
}

export type AnyEnvelope = { [K in TopicName]: Envelope<K> }[TopicName];

export type Unsubscribe = () => void;

export class Bus {
  #timeMs = 0;
  readonly #subscribers = new Set<(envelope: AnyEnvelope) => void>();

  get timeMs(): number {
    return this.#timeMs;
  }

  setTime(ms: number): void {
    this.#timeMs = ms;
  }

  publish<K extends TopicName>(topic: K, msg: TopicMap[K]): void {
    const envelope = { topic, t: this.#timeMs, msg } as AnyEnvelope;
    for (const subscriber of this.#subscribers) subscriber(envelope);
  }

  /** Subscribe to every topic (what a recorder does). */
  subscribe(handler: (envelope: AnyEnvelope) => void): Unsubscribe {
    this.#subscribers.add(handler);
    return () => this.#subscribers.delete(handler);
  }
}
