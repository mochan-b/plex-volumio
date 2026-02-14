/**
 * UI State Manager — computes derived UI state from PlaylistManager and
 * PlaybackController.
 *
 * Pure computation layer: reads state from the two controllers and returns
 * a single UIState snapshot. No side effects, no subscriptions.
 */

import type { Track } from "../types/index.js";
import type { PlaylistManager } from "../core/playlist-manager.js";
import type { PlaybackController } from "../core/playback-controller.js";

export interface CurrentTrackInfo {
  title: string;
  artist: string;
  album: string;
  artworkUrl: string | null;
}

export interface ProgressInfo {
  elapsed: number;
  total: number;
  percentage: number;
}

export interface ControlsInfo {
  canPlay: boolean;
  canPause: boolean;
  canNext: boolean;
  canPrevious: boolean;
}

export interface PlaylistEntry {
  track: Track;
  isCurrentTrack: boolean;
}

export interface UIState {
  currentTrack: CurrentTrackInfo | null;
  progress: ProgressInfo;
  controls: ControlsInfo;
  playlist: PlaylistEntry[];
}

export class UIStateManager {
  constructor(
    private readonly playlist: PlaylistManager,
    private readonly playback: PlaybackController,
  ) {}

  getUIState(): UIState {
    return {
      currentTrack: this.computeCurrentTrack(),
      progress: this.computeProgress(),
      controls: this.computeControls(),
      playlist: this.computePlaylist(),
    };
  }

  private computeCurrentTrack(): CurrentTrackInfo | null {
    const track = this.playback.getCurrentTrack();
    if (!track) return null;
    return {
      title: track.title,
      artist: track.artist,
      album: track.album,
      artworkUrl: track.artworkUrl,
    };
  }

  private computeProgress(): ProgressInfo {
    const track = this.playback.getCurrentTrack();
    const elapsed = this.playback.getPosition();
    const total = track?.duration ?? 0;
    return {
      elapsed,
      total,
      percentage: total > 0 ? (elapsed / total) * 100 : 0,
    };
  }

  private computeControls(): ControlsInfo {
    const state = this.playback.getState();
    const hasTracks = this.playlist.getLength() > 0;
    const position = this.playlist.getPosition();
    const length = this.playlist.getLength();
    const repeat = this.playlist.getRepeat();

    return {
      canPlay: state !== "playing" && hasTracks,
      canPause: state === "playing",
      canNext: hasTracks && (position < length - 1 || repeat !== "off"),
      canPrevious: hasTracks && (position > 0 || repeat !== "off"),
    };
  }

  private computePlaylist(): PlaylistEntry[] {
    const tracks = this.playlist.getPlaylist();
    const position = this.playlist.getPosition();

    return tracks.map((track, index) => ({
      track,
      isCurrentTrack: index === position,
    }));
  }
}
