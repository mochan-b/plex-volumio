import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "events";
import { PlaybackController } from "./playback-controller.js";
import type { StateChangedEvent, PlaybackErrorEvent } from "./playback-controller.js";
import type { Track } from "../types/index.js";

function makeTrack(id: string, title = `Track ${id}`): Track {
  return {
    id,
    title,
    artist: "Artist",
    album: "Album",
    duration: 200_000,
    artworkUrl: null,
    streamKey: `/library/parts/${id}/12345/file.flac`,
    trackType: null,
    samplerate: null,
    bitdepth: null,
  };
}

const trackA = makeTrack("1", "Alpha");
const trackB = makeTrack("2", "Bravo");

describe("PlaybackController", () => {
  let emitter: EventEmitter;
  let pc: PlaybackController;

  beforeEach(() => {
    emitter = new EventEmitter();
    pc = new PlaybackController(emitter);
  });

  // ── Initial state ──────────────────────────────────────────────

  it("starts in stopped state", () => {
    expect(pc.getState()).toBe("stopped");
    expect(pc.getPosition()).toBe(0);
    expect(pc.getCurrentTrack()).toBeNull();
  });

  // ── State transitions ──────────────────────────────────────────

  describe("play()", () => {
    it("transitions to playing when given a track", () => {
      pc.play(trackA);
      expect(pc.getState()).toBe("playing");
      expect(pc.getCurrentTrack()).toEqual(trackA);
    });

    it("resets position when playing a new track", () => {
      pc.play(trackA);
      pc.setPosition(50_000);
      pc.play(trackB);
      expect(pc.getPosition()).toBe(0);
      expect(pc.getCurrentTrack()).toEqual(trackB);
    });

    it("is a no-op when already playing and no new track given", () => {
      const listener = vi.fn();
      pc.play(trackA);
      emitter.on("stateChanged", listener);
      pc.play(); // resume call while already playing
      expect(listener).not.toHaveBeenCalled();
      expect(pc.getState()).toBe("playing");
    });

    it("resumes from paused without a track argument", () => {
      pc.play(trackA);
      pc.setPosition(30_000);
      pc.pause();
      pc.play();
      expect(pc.getState()).toBe("playing");
      expect(pc.getPosition()).toBe(30_000); // position preserved
    });

    it("does nothing when stopped with no track", () => {
      pc.play();
      expect(pc.getState()).toBe("stopped");
    });

    it("keeps position when re-playing the same track", () => {
      pc.play(trackA);
      pc.setPosition(60_000);
      pc.pause();
      pc.play(trackA); // same track
      expect(pc.getPosition()).toBe(60_000);
      expect(pc.getState()).toBe("playing");
    });
  });

  describe("pause()", () => {
    it("transitions from playing to paused", () => {
      pc.play(trackA);
      pc.pause();
      expect(pc.getState()).toBe("paused");
    });

    it("is a no-op when stopped", () => {
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.pause();
      expect(pc.getState()).toBe("stopped");
      expect(listener).not.toHaveBeenCalled();
    });

    it("is a no-op when already paused", () => {
      pc.play(trackA);
      pc.pause();
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.pause();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe("stop()", () => {
    it("transitions from playing to stopped", () => {
      pc.play(trackA);
      pc.stop();
      expect(pc.getState()).toBe("stopped");
      expect(pc.getPosition()).toBe(0);
      expect(pc.getCurrentTrack()).toBeNull();
    });

    it("transitions from paused to stopped", () => {
      pc.play(trackA);
      pc.pause();
      pc.stop();
      expect(pc.getState()).toBe("stopped");
    });

    it("is a no-op when already stopped", () => {
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.stop();
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Seek ───────────────────────────────────────────────────────

  describe("seek()", () => {
    it("updates position while playing", () => {
      pc.play(trackA);
      pc.seek(90_000);
      expect(pc.getPosition()).toBe(90_000);
    });

    it("updates position while paused", () => {
      pc.play(trackA);
      pc.pause();
      pc.seek(45_000);
      expect(pc.getPosition()).toBe(45_000);
    });

    it("clamps negative values to 0", () => {
      pc.play(trackA);
      pc.seek(-100);
      expect(pc.getPosition()).toBe(0);
    });

    it("is a no-op when stopped", () => {
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.seek(50_000);
      expect(pc.getPosition()).toBe(0);
      expect(listener).not.toHaveBeenCalled();
    });

    it("emits stateChanged with new position", () => {
      pc.play(trackA);
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.seek(70_000);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ position: 70_000 })
      );
    });
  });

  // ── Audio player callbacks ─────────────────────────────────────

  describe("onTrackEnded()", () => {
    it("resets to stopped state and emits trackEnded", () => {
      const listener = vi.fn();
      emitter.on("trackEnded", listener);
      pc.play(trackA);
      pc.onTrackEnded();
      expect(pc.getState()).toBe("stopped");
      expect(pc.getPosition()).toBe(0);
      expect(pc.getCurrentTrack()).toBeNull();
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe("onError()", () => {
    it("resets to stopped state and emits error", () => {
      const listener = vi.fn();
      emitter.on("error", listener);
      pc.play(trackA);
      const err = new Error("decode failure");
      pc.onError(err);
      expect(pc.getState()).toBe("stopped");
      expect(pc.getPosition()).toBe(0);
      expect(listener).toHaveBeenCalledWith({ error: err } satisfies PlaybackErrorEvent);
    });
  });

  // ── Event emission ─────────────────────────────────────────────

  describe("events", () => {
    it("emits stateChanged on play", () => {
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.play(trackA);
      expect(listener).toHaveBeenCalledWith({
        state: "playing",
        track: trackA,
        position: 0,
      } satisfies StateChangedEvent);
    });

    it("emits stateChanged on pause", () => {
      pc.play(trackA);
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.pause();
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ state: "paused", track: trackA })
      );
    });

    it("emits stateChanged on stop", () => {
      pc.play(trackA);
      const listener = vi.fn();
      emitter.on("stateChanged", listener);
      pc.stop();
      expect(listener).toHaveBeenCalledWith({
        state: "stopped",
        track: null,
        position: 0,
      } satisfies StateChangedEvent);
    });

    it("supports on/off for listener management", () => {
      const listener = vi.fn();
      pc.on("stateChanged", listener);
      pc.play(trackA);
      expect(listener).toHaveBeenCalledOnce();

      pc.off("stateChanged", listener);
      pc.pause();
      expect(listener).toHaveBeenCalledOnce(); // not called again
    });
  });

  // ── setPosition ────────────────────────────────────────────────

  describe("setPosition()", () => {
    it("updates internal position without emitting events", () => {
      const listener = vi.fn();
      pc.play(trackA);
      emitter.on("stateChanged", listener);
      pc.setPosition(120_000);
      expect(pc.getPosition()).toBe(120_000);
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Default emitter ────────────────────────────────────────────

  describe("default emitter", () => {
    it("creates its own emitter when none is provided", () => {
      const controller = new PlaybackController();
      const listener = vi.fn();
      controller.on("stateChanged", listener);
      controller.play(trackA);
      expect(listener).toHaveBeenCalledOnce();
      expect(controller.getState()).toBe("playing");
    });
  });
});
