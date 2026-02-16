/**
 * Interactive script to browse a real Plex server and play a track.
 *
 * Flow:
 *   1. Select a music library
 *   2. Choose "Albums" or "Playlists"
 *   3. Select an album or playlist
 *   4. Select a track
 *   5. Stream it via ffplay
 *
 * Usage:
 *   npx tsx scripts/play.ts --host 192.168.1.100 --port 32400 --token TOKEN
 *
 * Connection details can also be set via PLEX_HOST, PLEX_PORT, PLEX_TOKEN env vars.
 */

import * as readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { parseLibraries, parseAlbums, parsePlaylists, parseTracks } from "../src/core/parser.js";
import { buildStreamUrl } from "../src/core/stream-resolver.js";
import type {
  Library,
  Track,
  RawLibraryResponse,
  RawAlbumResponse,
  RawPlaylistResponse,
  RawTrackResponse,
} from "../src/types/index.js";

// ── CLI argument parsing ─────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

const host = getArg("host") ?? process.env["PLEX_HOST"] ?? "localhost";
const port = getArg("port") ?? process.env["PLEX_PORT"] ?? "32400";
const token = getArg("token") ?? process.env["PLEX_TOKEN"];
const useHttps = process.argv.includes("--https") || process.env["PLEX_HTTPS"] === "true";

if (!token) {
  console.error("Error: Plex token is required.");
  console.error("  Pass --token YOUR_TOKEN or set PLEX_TOKEN env var.");
  process.exit(1);
}

const plexToken: string = token;
const scheme = useHttps ? "https" : "http";
const baseUrl = `${scheme}://${host}:${port}`;

// ── Helpers ──────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

async function plexFetch<T>(path: string): Promise<T> {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    headers: {
      "X-Plex-Token": plexToken,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Plex API ${res.status} ${res.statusText} — GET ${path}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Prompt the user to pick from a numbered list.
 * Returns the selected item, or null if the user types "q".
 */
async function pick<T>(label: string, items: T[], display: (item: T, i: number) => string): Promise<T | null> {
  console.log(`\n${label}:`);
  for (let i = 0; i < items.length; i++) {
    console.log(`  ${String(i + 1).padStart(3)}. ${display(items[i]!, i)}`);
  }
  const answer = await rl.question("\nSelect number (q to quit): ");
  if (answer.trim().toLowerCase() === "q") return null;

  const idx = parseInt(answer, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= items.length) {
    console.log("Invalid selection.");
    return pick(label, items, display);
  }
  return items[idx]!;
}

// ── Browsing ─────────────────────────────────────────────────────────

async function selectLibrary(): Promise<Library | null> {
  const raw = await plexFetch<RawLibraryResponse>("/library/sections");
  const libraries = parseLibraries(raw);
  if (libraries.length === 0) {
    console.log("No music libraries found.");
    return null;
  }
  if (libraries.length === 1) {
    console.log(`\nUsing library: ${libraries[0]!.title}`);
    return libraries[0]!;
  }
  return pick("Music Libraries", libraries, (lib) => lib.title);
}

async function selectTrackFromAlbums(library: Library): Promise<Track | null> {
  const rawAlbums = await plexFetch<RawAlbumResponse>(
    `/library/sections/${library.id}/all?type=9`
  );
  const albums = parseAlbums(rawAlbums);
  if (albums.length === 0) {
    console.log("No albums found.");
    return null;
  }

  const album = await pick("Albums", albums, (a) => {
    const year = a.year ? ` (${a.year})` : "";
    return `${a.artist} — ${a.title}${year}`;
  });
  if (!album) return null;

  const rawTracks = await plexFetch<RawTrackResponse>(album.trackListKey);
  const tracks = parseTracks(rawTracks);
  if (tracks.length === 0) {
    console.log("No tracks found.");
    return null;
  }

  return pick("Tracks", tracks, (t) => `${t.title}  [${formatDuration(t.duration)}]`);
}

async function selectTrackFromPlaylists(): Promise<Track | null> {
  const rawPlaylists = await plexFetch<RawPlaylistResponse>("/playlists");
  const playlists = parsePlaylists(rawPlaylists);
  if (playlists.length === 0) {
    console.log("No audio playlists found.");
    return null;
  }

  const playlist = await pick("Playlists", playlists, (p) => `${p.title}  (${p.trackCount} tracks)`);
  if (!playlist) return null;

  const rawTracks = await plexFetch<RawTrackResponse>(playlist.itemsKey);
  const tracks = parseTracks(rawTracks);
  if (tracks.length === 0) {
    console.log("Playlist is empty.");
    return null;
  }

  return pick("Tracks", tracks, (t) => `${t.artist} — ${t.title}  [${formatDuration(t.duration)}]`);
}

// ── Playback ─────────────────────────────────────────────────────────

function playWithFfplay(url: string, track: Track): void {
  console.log(`\nPlaying: ${track.artist} — ${track.title}`);
  console.log(`Album:   ${track.album}`);
  console.log(`URL:     ${url.replace(/X-Plex-Token=[^&]+/, "X-Plex-Token=████████")}`);
  console.log("\nPress q in the player window to stop.\n");

  const child = spawn("ffplay", ["-nodisp", "-autoexit", url], {
    stdio: "inherit",
  });

  child.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      console.error("ffplay not found. Install ffmpeg to enable playback.");
      console.error("  sudo apt install ffmpeg");
    } else {
      console.error("Playback error:", err.message);
    }
  });

  child.on("close", (code) => {
    console.log(code === 0 ? "\nPlayback finished." : `\nffplay exited with code ${code}`);
    rl.close();
  });
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  console.log(`Connecting to Plex at ${baseUrl} ...`);

  const library = await selectLibrary();
  if (!library) return rl.close();

  const mode = await pick("Browse by", ["Albums", "Playlists"], (s) => s);
  if (!mode) return rl.close();

  let track: Track | null;
  if (mode === "Albums") {
    track = await selectTrackFromAlbums(library);
  } else {
    track = await selectTrackFromPlaylists();
  }

  if (!track) return rl.close();

  const url = buildStreamUrl({
    host,
    port: parseInt(port, 10),
    token: plexToken,
    https: useHttps,
    trackKey: track.streamKey,
  });

  playWithFfplay(url, track);
}

main().catch((err) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  rl.close();
  process.exit(1);
});
