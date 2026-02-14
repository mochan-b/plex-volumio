/**
 * Playlist Manager — manages queue state and track ordering.
 *
 * Self-contained state management with no external dependencies.
 * Supports sequential and shuffled playback, plus repeat modes.
 */

import type { Track } from "../types/index.js";

export type RepeatMode = "off" | "all" | "one";

export class PlaylistManager {
  private tracks: Track[] = [];
  private position = -1;
  private shuffle = false;
  private repeat: RepeatMode = "off";

  /** The shuffled index order. Only used when shuffle is enabled. */
  private shuffleOrder: number[] = [];

  // ── Mutators ─────────────────────────────────────────────────────

  addTrack(track: Track): void {
    this.tracks.push(track);
    if (this.position === -1) {
      this.position = 0;
    }
    if (this.shuffle) {
      this.rebuildShuffleOrder();
    }
  }

  addTracks(tracks: Track[]): void {
    if (tracks.length === 0) return;
    this.tracks.push(...tracks);
    if (this.position === -1) {
      this.position = 0;
    }
    if (this.shuffle) {
      this.rebuildShuffleOrder();
    }
  }

  removeTrack(index: number): void {
    if (index < 0 || index >= this.tracks.length) return;

    this.tracks.splice(index, 1);

    if (this.tracks.length === 0) {
      this.position = -1;
    } else if (index < this.position) {
      // Removed a track before the current one — shift position back
      this.position--;
    } else if (index === this.position && this.position >= this.tracks.length) {
      // Removed the current track and it was the last one — clamp
      this.position = this.tracks.length - 1;
    }

    if (this.shuffle) {
      this.rebuildShuffleOrder();
    }
  }

  clear(): void {
    this.tracks = [];
    this.position = -1;
    this.shuffleOrder = [];
  }

  // ── Queries ──────────────────────────────────────────────────────

  getCurrentTrack(): Track | null {
    if (this.position < 0 || this.position >= this.tracks.length) return null;
    return this.tracks[this.resolveIndex(this.position)]!;
  }

  getPlaylist(): Track[] {
    return [...this.tracks];
  }

  getPosition(): number {
    return this.position;
  }

  getLength(): number {
    return this.tracks.length;
  }

  getShuffle(): boolean {
    return this.shuffle;
  }

  getRepeat(): RepeatMode {
    return this.repeat;
  }

  // ── Navigation ───────────────────────────────────────────────────

  next(): Track | null {
    if (this.tracks.length === 0) return null;

    if (this.repeat === "one") {
      // Stay on the same track
      return this.getCurrentTrack();
    }

    if (this.position < this.tracks.length - 1) {
      this.position++;
      return this.getCurrentTrack();
    }

    // At the end of the list
    if (this.repeat === "all") {
      this.position = 0;
      if (this.shuffle) {
        this.rebuildShuffleOrder();
      }
      return this.getCurrentTrack();
    }

    // repeat === "off" and at end — stay on last track, return null
    return null;
  }

  previous(): Track | null {
    if (this.tracks.length === 0) return null;

    if (this.repeat === "one") {
      return this.getCurrentTrack();
    }

    if (this.position > 0) {
      this.position--;
      return this.getCurrentTrack();
    }

    // At the start of the list
    if (this.repeat === "all") {
      this.position = this.tracks.length - 1;
      return this.getCurrentTrack();
    }

    // repeat === "off" and at start — stay on first track, return null
    return null;
  }

  jumpTo(index: number): Track | null {
    if (index < 0 || index >= this.tracks.length) return null;
    this.position = index;
    return this.getCurrentTrack();
  }

  // ── Mode setters ─────────────────────────────────────────────────

  setShuffle(enabled: boolean): void {
    this.shuffle = enabled;
    if (enabled) {
      this.rebuildShuffleOrder();
    } else {
      this.shuffleOrder = [];
    }
  }

  setRepeat(mode: RepeatMode): void {
    this.repeat = mode;
  }

  // ── Internal ─────────────────────────────────────────────────────

  /**
   * Resolve a logical position to an actual track index.
   * When shuffle is enabled, maps through the shuffle order.
   */
  private resolveIndex(position: number): number {
    if (this.shuffle && this.shuffleOrder.length > 0) {
      return this.shuffleOrder[position]!;
    }
    return position;
  }

  /**
   * Rebuild the shuffle order. The current track (if any) is placed first
   * so that enabling shuffle mid-playback doesn't skip the current track.
   */
  private rebuildShuffleOrder(): void {
    const indices = Array.from({ length: this.tracks.length }, (_, i) => i);

    // Fisher-Yates shuffle
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j]!, indices[i]!];
    }

    // If we have a current position, ensure its real index is first
    if (this.position >= 0 && this.position < this.tracks.length) {
      const currentRealIndex = this.shuffle && this.shuffleOrder.length > 0
        ? this.shuffleOrder[this.position]!
        : this.position;
      const currentShuffledPos = indices.indexOf(currentRealIndex);
      if (currentShuffledPos > 0) {
        [indices[0], indices[currentShuffledPos]] = [indices[currentShuffledPos]!, indices[0]!];
      }
      // Reset position to 0 since current track is now first in the shuffle
      this.position = 0;
    }

    this.shuffleOrder = indices;
  }
}
