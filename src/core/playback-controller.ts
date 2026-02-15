/**
 * Playback Controller — manages the playback state machine.
 *
 * Tracks state transitions (stopped → playing → paused), elapsed position,
 * and emits events for state changes, track endings, and errors.
 * No audio player or Volumio dependency — purely a state machine.
 */

import { EventEmitter } from "events";
import type { Track } from "../types/index.js";

export type PlaybackState = "stopped" | "playing" | "paused";

export interface StateChangedEvent {
  state: PlaybackState;
  track: Track | null;
  position: number;
}

export interface PlaybackErrorEvent {
  error: Error;
}

/**
 * Events emitted by PlaybackController:
 * - `stateChanged` → StateChangedEvent
 * - `trackEnded`   → void
 * - `error`        → PlaybackErrorEvent
 */
export class PlaybackController {
  private state: PlaybackState = "stopped";
  private positionMs = 0;
  private currentTrack: Track | null = null;
  private readonly emitter: EventEmitter;

  constructor(emitter?: EventEmitter) {
    this.emitter = emitter ?? new EventEmitter();
  }

  // ── Commands ─────────────────────────────────────────────────────

  /**
   * Start or resume playback of the given track (or current track if none provided).
   * No-op if already playing the same track.
   */
  play(track?: Track): void {
    if (track) {
      // New track — reset position and start playing
      const isNewTrack = !this.currentTrack || this.currentTrack.id !== track.id;
      if (isNewTrack) {
        this.positionMs = 0;
      }
      this.currentTrack = track;
      this.setState("playing");
      return;
    }

    // Resume: no-op if already playing
    if (this.state === "playing") return;

    // Can only resume if we have a track
    if (this.currentTrack) {
      this.setState("playing");
    }
  }

  pause(): void {
    if (this.state !== "playing") return;
    this.setState("paused");
  }

  stop(): void {
    if (this.state === "stopped") return;
    this.positionMs = 0;
    this.currentTrack = null;
    this.setState("stopped");
  }

  seek(positionMs: number): void {
    if (this.state === "stopped" || !this.currentTrack) return;
    this.positionMs = Math.max(0, positionMs);
    this.emitStateChanged();
  }

  // ── Callbacks from audio player ──────────────────────────────────

  /** Called by the audio layer when the current track finishes naturally. */
  onTrackEnded(): void {
    this.positionMs = 0;
    this.currentTrack = null;
    this.state = "stopped";
    this.emitter.emit("trackEnded");
  }

  /** Called by the audio layer on playback error. */
  onError(error: Error): void {
    this.state = "stopped";
    this.positionMs = 0;
    this.emitter.emit("error", { error } satisfies PlaybackErrorEvent);
  }

  // ── Queries ──────────────────────────────────────────────────────

  getState(): PlaybackState {
    return this.state;
  }

  getPosition(): number {
    return this.positionMs;
  }

  getCurrentTrack(): Track | null {
    return this.currentTrack;
  }

  /**
   * Update the elapsed position. Intended to be called periodically
   * by the audio layer to keep the state in sync.
   */
  setPosition(positionMs: number): void {
    this.positionMs = positionMs;
  }

  // ── Event subscription (delegates to internal emitter) ───────────

  on(event: "stateChanged", listener: (e: StateChangedEvent) => void): void;
  on(event: "trackEnded", listener: () => void): void;
  on(event: "error", listener: (e: PlaybackErrorEvent) => void): void;
  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.emitter.off(event, listener);
  }

  // ── Internal ─────────────────────────────────────────────────────

  private setState(newState: PlaybackState): void {
    this.state = newState;
    this.emitStateChanged();
  }

  private emitStateChanged(): void {
    this.emitter.emit("stateChanged", {
      state: this.state,
      track: this.currentTrack,
      position: this.positionMs,
    } satisfies StateChangedEvent);
  }
}
