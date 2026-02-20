import { describe, it, expect, beforeEach } from "vitest";
import { PlaylistManager } from "./playlist-manager.js";
import type { Track } from "../types/index.js";

/** Helper to create a Track with minimal required fields. */
function makeTrack(id: string, title = `Track ${id}`): Track {
  return {
    id,
    title,
    artist: "Artist",
    album: "Album",
    duration: 180_000,
    artworkUrl: null,
    streamKey: `/library/parts/${id}/12345/file.flac`,
    trackType: null,
    samplerate: null,
    bitdepth: null,
  };
}

const trackA = makeTrack("1", "Alpha");
const trackB = makeTrack("2", "Bravo");
const trackC = makeTrack("3", "Charlie");
const trackD = makeTrack("4", "Delta");

describe("PlaylistManager", () => {
  let pm: PlaylistManager;

  beforeEach(() => {
    pm = new PlaylistManager();
  });

  // ── Adding tracks ──────────────────────────────────────────────

  describe("addTrack", () => {
    it("adds a track to the queue", () => {
      pm.addTrack(trackA);
      expect(pm.getPlaylist()).toEqual([trackA]);
      expect(pm.getLength()).toBe(1);
    });

    it("sets position to 0 when first track is added", () => {
      expect(pm.getPosition()).toBe(-1);
      pm.addTrack(trackA);
      expect(pm.getPosition()).toBe(0);
    });

    it("does not change position when subsequent tracks are added", () => {
      pm.addTrack(trackA);
      pm.next();
      pm.addTrack(trackB);
      // position should still reflect where we navigated to
      expect(pm.getPosition()).toBe(0); // next() returned null (only 1 track, repeat off)
    });
  });

  describe("addTracks", () => {
    it("adds multiple tracks at once", () => {
      pm.addTracks([trackA, trackB, trackC]);
      expect(pm.getPlaylist()).toEqual([trackA, trackB, trackC]);
      expect(pm.getLength()).toBe(3);
    });

    it("sets position to 0 on first batch", () => {
      pm.addTracks([trackA, trackB]);
      expect(pm.getPosition()).toBe(0);
    });

    it("ignores empty array", () => {
      pm.addTracks([]);
      expect(pm.getLength()).toBe(0);
      expect(pm.getPosition()).toBe(-1);
    });
  });

  // ── Removing tracks ────────────────────────────────────────────

  describe("removeTrack", () => {
    it("removes track at the given index", () => {
      pm.addTracks([trackA, trackB, trackC]);
      pm.removeTrack(1);
      expect(pm.getPlaylist()).toEqual([trackA, trackC]);
    });

    it("adjusts position when a track before current is removed", () => {
      pm.addTracks([trackA, trackB, trackC]);
      pm.jumpTo(2); // pointing at Charlie
      pm.removeTrack(0); // remove Alpha
      expect(pm.getPosition()).toBe(1);
      expect(pm.getCurrentTrack()).toEqual(trackC);
    });

    it("clamps position when current track (last) is removed", () => {
      pm.addTracks([trackA, trackB]);
      pm.jumpTo(1);
      pm.removeTrack(1);
      expect(pm.getPosition()).toBe(0);
      expect(pm.getCurrentTrack()).toEqual(trackA);
    });

    it("resets position to -1 when last track is removed", () => {
      pm.addTrack(trackA);
      pm.removeTrack(0);
      expect(pm.getPosition()).toBe(-1);
      expect(pm.getCurrentTrack()).toBeNull();
    });

    it("ignores out-of-bounds index", () => {
      pm.addTrack(trackA);
      pm.removeTrack(5);
      pm.removeTrack(-1);
      expect(pm.getLength()).toBe(1);
    });
  });

  // ── Clear ──────────────────────────────────────────────────────

  describe("clear", () => {
    it("resets all state", () => {
      pm.addTracks([trackA, trackB, trackC]);
      pm.next();
      pm.setShuffle(true);
      pm.setRepeat("all");
      pm.clear();
      expect(pm.getPlaylist()).toEqual([]);
      expect(pm.getPosition()).toBe(-1);
      expect(pm.getCurrentTrack()).toBeNull();
      expect(pm.getLength()).toBe(0);
    });
  });

  // ── Navigation — sequential ────────────────────────────────────

  describe("next()", () => {
    it("advances position", () => {
      pm.addTracks([trackA, trackB, trackC]);
      const track = pm.next();
      expect(track).toEqual(trackB);
      expect(pm.getPosition()).toBe(1);
    });

    it("returns null at end with repeat off", () => {
      pm.addTracks([trackA, trackB]);
      pm.jumpTo(1);
      const track = pm.next();
      expect(track).toBeNull();
      expect(pm.getPosition()).toBe(1); // stays at last
    });

    it("wraps to start with repeat all", () => {
      pm.addTracks([trackA, trackB]);
      pm.setRepeat("all");
      pm.jumpTo(1);
      const track = pm.next();
      expect(track).toEqual(trackA);
      expect(pm.getPosition()).toBe(0);
    });

    it("returns same track with repeat one", () => {
      pm.addTracks([trackA, trackB]);
      pm.setRepeat("one");
      const track = pm.next();
      expect(track).toEqual(trackA);
      expect(pm.getPosition()).toBe(0); // stays put
    });

    it("returns null on empty playlist", () => {
      expect(pm.next()).toBeNull();
    });
  });

  describe("previous()", () => {
    it("goes back one position", () => {
      pm.addTracks([trackA, trackB, trackC]);
      pm.jumpTo(2);
      const track = pm.previous();
      expect(track).toEqual(trackB);
      expect(pm.getPosition()).toBe(1);
    });

    it("returns null at start with repeat off", () => {
      pm.addTracks([trackA, trackB]);
      const track = pm.previous();
      expect(track).toBeNull();
      expect(pm.getPosition()).toBe(0); // stays at first
    });

    it("wraps to end with repeat all", () => {
      pm.addTracks([trackA, trackB, trackC]);
      pm.setRepeat("all");
      const track = pm.previous();
      expect(track).toEqual(trackC);
      expect(pm.getPosition()).toBe(2);
    });

    it("returns same track with repeat one", () => {
      pm.addTracks([trackA, trackB]);
      pm.jumpTo(1);
      pm.setRepeat("one");
      const track = pm.previous();
      expect(track).toEqual(trackB);
      expect(pm.getPosition()).toBe(1);
    });
  });

  describe("jumpTo()", () => {
    it("jumps to valid index", () => {
      pm.addTracks([trackA, trackB, trackC]);
      const track = pm.jumpTo(2);
      expect(track).toEqual(trackC);
      expect(pm.getPosition()).toBe(2);
    });

    it("returns null for out-of-bounds index", () => {
      pm.addTracks([trackA]);
      expect(pm.jumpTo(-1)).toBeNull();
      expect(pm.jumpTo(5)).toBeNull();
    });
  });

  // ── getCurrentTrack ────────────────────────────────────────────

  describe("getCurrentTrack()", () => {
    it("returns null when playlist is empty", () => {
      expect(pm.getCurrentTrack()).toBeNull();
    });

    it("returns first track after adding tracks", () => {
      pm.addTracks([trackA, trackB]);
      expect(pm.getCurrentTrack()).toEqual(trackA);
    });
  });

  // ── Shuffle ────────────────────────────────────────────────────

  describe("shuffle", () => {
    it("defaults to off", () => {
      expect(pm.getShuffle()).toBe(false);
    });

    it("can be toggled", () => {
      pm.setShuffle(true);
      expect(pm.getShuffle()).toBe(true);
      pm.setShuffle(false);
      expect(pm.getShuffle()).toBe(false);
    });

    it("returns all tracks when iterating through shuffled playlist", () => {
      pm.addTracks([trackA, trackB, trackC, trackD]);
      pm.setShuffle(true);
      pm.setRepeat("off");

      const seen: Track[] = [];
      // Current track is repositioned to index 0 by shuffle
      seen.push(pm.getCurrentTrack()!);
      let t: Track | null;
      while ((t = pm.next()) !== null) {
        seen.push(t);
      }

      // Should see all 4 tracks exactly once (but in some shuffled order)
      expect(seen).toHaveLength(4);
      const ids = seen.map((tr) => tr.id).sort();
      expect(ids).toEqual(["1", "2", "3", "4"]);
    });

    it("keeps current track when shuffle is enabled mid-playback", () => {
      pm.addTracks([trackA, trackB, trackC]);
      pm.jumpTo(1); // pointing at Bravo
      pm.setShuffle(true);
      // After shuffle, position resets to 0 but the current track should be Bravo
      expect(pm.getCurrentTrack()).toEqual(trackB);
    });
  });

  // ── Repeat modes ───────────────────────────────────────────────

  describe("repeat modes", () => {
    it("defaults to off", () => {
      expect(pm.getRepeat()).toBe("off");
    });

    it("can cycle through modes", () => {
      pm.setRepeat("all");
      expect(pm.getRepeat()).toBe("all");
      pm.setRepeat("one");
      expect(pm.getRepeat()).toBe("one");
      pm.setRepeat("off");
      expect(pm.getRepeat()).toBe("off");
    });
  });

  // ── getPlaylist returns a copy ─────────────────────────────────

  describe("getPlaylist", () => {
    it("returns a copy, not the internal array", () => {
      pm.addTracks([trackA, trackB]);
      const list = pm.getPlaylist();
      list.push(trackC);
      expect(pm.getLength()).toBe(2); // internal list unchanged
    });
  });
});
