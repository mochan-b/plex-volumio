import { describe, it, expect, beforeEach } from "vitest";
import { UIStateManager } from "./ui-state-manager.js";
import { PlaylistManager } from "../core/playlist-manager.js";
import { PlaybackController } from "../core/playback-controller.js";
import type { Track } from "../types/index.js";

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    id: "1",
    title: "Test Track",
    artist: "Test Artist",
    album: "Test Album",
    duration: 240_000,
    artworkUrl: "/art/1.jpg",
    streamKey: "/library/parts/1/file.flac",
    ...overrides,
  };
}

describe("UIStateManager", () => {
  let playlist: PlaylistManager;
  let playback: PlaybackController;
  let ui: UIStateManager;

  beforeEach(() => {
    playlist = new PlaylistManager();
    playback = new PlaybackController();
    ui = new UIStateManager(playlist, playback);
  });

  // ── currentTrack ────────────────────────────────────────────────────

  describe("currentTrack", () => {
    it("returns null when playlist is empty", () => {
      const state = ui.getUIState();
      expect(state.currentTrack).toBeNull();
    });

    it("returns null when stopped with no track", () => {
      playlist.addTrack(makeTrack());
      // playback has no current track since play() was never called
      const state = ui.getUIState();
      expect(state.currentTrack).toBeNull();
    });

    it("returns track info when playing", () => {
      const track = makeTrack({
        title: "Shine On",
        artist: "Pink Floyd",
        album: "Wish You Were Here",
        artworkUrl: "/art/shine.jpg",
      });
      playlist.addTrack(track);
      playback.play(track);

      const state = ui.getUIState();
      expect(state.currentTrack).toEqual({
        title: "Shine On",
        artist: "Pink Floyd",
        album: "Wish You Were Here",
        artworkUrl: "/art/shine.jpg",
      });
    });

    it("returns null artworkUrl when track has no artwork", () => {
      const track = makeTrack({ artworkUrl: null });
      playback.play(track);

      const state = ui.getUIState();
      expect(state.currentTrack!.artworkUrl).toBeNull();
    });
  });

  // ── progress ────────────────────────────────────────────────────────

  describe("progress", () => {
    it("returns zeros when no track is playing", () => {
      const state = ui.getUIState();
      expect(state.progress).toEqual({
        elapsed: 0,
        total: 0,
        percentage: 0,
      });
    });

    it("calculates progress percentage correctly", () => {
      const track = makeTrack({ duration: 200_000 });
      playback.play(track);
      playback.setPosition(100_000);

      const state = ui.getUIState();
      expect(state.progress).toEqual({
        elapsed: 100_000,
        total: 200_000,
        percentage: 50,
      });
    });

    it("handles position at start", () => {
      const track = makeTrack({ duration: 300_000 });
      playback.play(track);

      const state = ui.getUIState();
      expect(state.progress.elapsed).toBe(0);
      expect(state.progress.percentage).toBe(0);
    });

    it("handles position near end", () => {
      const track = makeTrack({ duration: 100_000 });
      playback.play(track);
      playback.setPosition(99_000);

      const state = ui.getUIState();
      expect(state.progress.percentage).toBe(99);
    });
  });

  // ── controls ────────────────────────────────────────────────────────

  describe("controls", () => {
    it("disables all controls when playlist is empty", () => {
      const state = ui.getUIState();
      expect(state.controls).toEqual({
        canPlay: false,
        canPause: false,
        canNext: false,
        canPrevious: false,
      });
    });

    it("canPlay is true when stopped with tracks", () => {
      playlist.addTrack(makeTrack());
      const state = ui.getUIState();
      expect(state.controls.canPlay).toBe(true);
    });

    it("canPlay is false when already playing", () => {
      const track = makeTrack();
      playlist.addTrack(track);
      playback.play(track);
      const state = ui.getUIState();
      expect(state.controls.canPlay).toBe(false);
    });

    it("canPlay is true when paused", () => {
      const track = makeTrack();
      playlist.addTrack(track);
      playback.play(track);
      playback.pause();
      const state = ui.getUIState();
      expect(state.controls.canPlay).toBe(true);
    });

    it("canPause is true only when playing", () => {
      const track = makeTrack();
      playlist.addTrack(track);

      expect(ui.getUIState().controls.canPause).toBe(false);

      playback.play(track);
      expect(ui.getUIState().controls.canPause).toBe(true);

      playback.pause();
      expect(ui.getUIState().controls.canPause).toBe(false);
    });

    it("canPrevious is false at start of playlist (repeat off)", () => {
      playlist.addTracks([makeTrack({ id: "1" }), makeTrack({ id: "2" })]);
      // Position is 0 (first track)
      const state = ui.getUIState();
      expect(state.controls.canPrevious).toBe(false);
    });

    it("canPrevious is true when not at start", () => {
      playlist.addTracks([makeTrack({ id: "1" }), makeTrack({ id: "2" })]);
      playlist.next();
      const state = ui.getUIState();
      expect(state.controls.canPrevious).toBe(true);
    });

    it("canNext is false at end of playlist (repeat off)", () => {
      playlist.addTracks([makeTrack({ id: "1" }), makeTrack({ id: "2" })]);
      playlist.next(); // move to last track
      const state = ui.getUIState();
      expect(state.controls.canNext).toBe(false);
    });

    it("canNext is true when not at end", () => {
      playlist.addTracks([makeTrack({ id: "1" }), makeTrack({ id: "2" })]);
      const state = ui.getUIState();
      expect(state.controls.canNext).toBe(true);
    });

    it("canNext is true at end when repeat is all", () => {
      playlist.addTracks([makeTrack({ id: "1" }), makeTrack({ id: "2" })]);
      playlist.next(); // move to last
      playlist.setRepeat("all");
      const state = ui.getUIState();
      expect(state.controls.canNext).toBe(true);
    });

    it("canPrevious is true at start when repeat is all", () => {
      playlist.addTracks([makeTrack({ id: "1" }), makeTrack({ id: "2" })]);
      playlist.setRepeat("all");
      const state = ui.getUIState();
      expect(state.controls.canPrevious).toBe(true);
    });

    it("canNext is true with repeat one", () => {
      playlist.addTracks([makeTrack({ id: "1" })]);
      playlist.setRepeat("one");
      const state = ui.getUIState();
      expect(state.controls.canNext).toBe(true);
    });

    it("canPrevious is true with repeat one", () => {
      playlist.addTracks([makeTrack({ id: "1" })]);
      playlist.setRepeat("one");
      const state = ui.getUIState();
      expect(state.controls.canPrevious).toBe(true);
    });

    it("single track with repeat off: canNext and canPrevious both false", () => {
      playlist.addTrack(makeTrack());
      const state = ui.getUIState();
      expect(state.controls.canNext).toBe(false);
      expect(state.controls.canPrevious).toBe(false);
    });
  });

  // ── playlist ────────────────────────────────────────────────────────

  describe("playlist", () => {
    it("returns empty array when no tracks", () => {
      const state = ui.getUIState();
      expect(state.playlist).toEqual([]);
    });

    it("marks current track in playlist", () => {
      const t1 = makeTrack({ id: "1", title: "Track 1" });
      const t2 = makeTrack({ id: "2", title: "Track 2" });
      const t3 = makeTrack({ id: "3", title: "Track 3" });
      playlist.addTracks([t1, t2, t3]);

      const state = ui.getUIState();
      expect(state.playlist).toHaveLength(3);
      expect(state.playlist[0]!.isCurrentTrack).toBe(true);
      expect(state.playlist[1]!.isCurrentTrack).toBe(false);
      expect(state.playlist[2]!.isCurrentTrack).toBe(false);
    });

    it("updates current track marker after navigation", () => {
      const t1 = makeTrack({ id: "1" });
      const t2 = makeTrack({ id: "2" });
      playlist.addTracks([t1, t2]);
      playlist.next();

      const state = ui.getUIState();
      expect(state.playlist[0]!.isCurrentTrack).toBe(false);
      expect(state.playlist[1]!.isCurrentTrack).toBe(true);
    });

    it("includes full track data in each entry", () => {
      const track = makeTrack({
        id: "42",
        title: "Deep Track",
        artist: "Artist X",
        album: "Album Y",
        duration: 180_000,
        artworkUrl: "/art/42.jpg",
        streamKey: "/library/parts/42/file.flac",
      });
      playlist.addTrack(track);

      const state = ui.getUIState();
      expect(state.playlist[0]!.track).toEqual(track);
    });
  });
});
