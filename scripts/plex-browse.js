"use strict";
/**
 * Quick diagnostic script to browse a real Plex server and print
 * music libraries/albums or audio playlists with tracks.
 *
 * Usage:
 *   npx tsx scripts/plex-browse.ts --mode albums   --host 192.168.1.100 --port 32400 --token TOKEN
 *   npx tsx scripts/plex-browse.ts --mode playlists --host 192.168.1.100 --port 32400 --token TOKEN
 *
 * --mode       "albums" (default) or "playlists"
 * --host       Plex server host (default: PLEX_HOST env or "localhost")
 * --port       Plex server port (default: PLEX_PORT env or "32400")
 * --token      Plex auth token  (default: PLEX_TOKEN env, required)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const parser_js_1 = require("../src/core/parser.js");
// ── CLI argument parsing ─────────────────────────────────────────────
function getArg(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index !== -1 ? process.argv[index + 1] : undefined;
}
const mode = getArg("mode") ?? "albums";
const host = getArg("host") ?? process.env["PLEX_HOST"] ?? "localhost";
const port = getArg("port") ?? process.env["PLEX_PORT"] ?? "32400";
const token = getArg("token") ?? process.env["PLEX_TOKEN"];
if (!token) {
    console.error("Error: Plex token is required.");
    console.error("  Pass --token YOUR_TOKEN or set PLEX_TOKEN env var.");
    console.error("");
    console.error("Usage:");
    console.error("  npx tsx scripts/plex-browse.ts --mode albums   --token YOUR_TOKEN");
    console.error("  npx tsx scripts/plex-browse.ts --mode playlists --token YOUR_TOKEN");
    process.exit(1);
}
const plexToken = token;
if (mode !== "albums" && mode !== "playlists") {
    console.error(`Error: Unknown mode "${mode}". Use "albums" or "playlists".`);
    process.exit(1);
}
const baseUrl = `http://${host}:${port}`;
// ── Helpers ──────────────────────────────────────────────────────────
/** Format milliseconds as m:ss (e.g. 282000 → "4:42"). */
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
/** Make an authenticated GET request to the Plex API, returning JSON. */
async function plexFetch(path) {
    const url = `${baseUrl}${path}`;
    const res = await fetch(url, {
        headers: {
            "X-Plex-Token": plexToken,
            "Accept": "application/json",
        },
    });
    if (!res.ok) {
        throw new Error(`Plex API ${res.status} ${res.statusText} — GET ${path}`);
    }
    return res.json();
}
// ── Albums mode ──────────────────────────────────────────────────────
async function browseAlbums() {
    // Fetch and parse libraries, filtering to music-only
    const rawLibraries = await plexFetch("/library/sections");
    const libraries = (0, parser_js_1.parseLibraries)(rawLibraries);
    if (libraries.length === 0) {
        console.log("No music libraries found on this server.");
        return;
    }
    console.log(`Found ${libraries.length} music library(ies):\n`);
    // For each music library, fetch and print its albums
    for (const lib of libraries) {
        console.log(`── ${lib.title} (id: ${lib.id}) ──────────────────────`);
        // type=9 tells Plex to return albums
        const rawAlbums = await plexFetch(`/library/sections/${lib.id}/all?type=9`);
        const albums = (0, parser_js_1.parseAlbums)(rawAlbums);
        if (albums.length === 0) {
            console.log("  (no albums)\n");
            continue;
        }
        console.log(`  ${albums.length} album(s):\n`);
        for (const album of albums) {
            const year = album.year ? ` (${album.year})` : "";
            console.log(`    ${album.artist} — ${album.title}${year}`);
        }
        console.log("");
    }
}
// ── Playlists mode ───────────────────────────────────────────────────
async function browsePlaylists() {
    // Fetch and parse playlists, filtering to audio-only
    const rawPlaylists = await plexFetch("/playlists");
    const playlists = (0, parser_js_1.parsePlaylists)(rawPlaylists);
    if (playlists.length === 0) {
        console.log("No audio playlists found on this server.");
        return;
    }
    console.log(`Found ${playlists.length} audio playlist(s):\n`);
    // For each playlist, fetch and print its tracks
    for (const playlist of playlists) {
        console.log(`── ${playlist.title} (${playlist.trackCount} tracks) ──────────────────────`);
        const rawTracks = await plexFetch(playlist.itemsKey);
        const tracks = (0, parser_js_1.parseTracks)(rawTracks);
        if (tracks.length === 0) {
            console.log("  (empty playlist)\n");
            continue;
        }
        const preview = tracks.slice(0, 10);
        for (let i = 0; i < preview.length; i++) {
            const track = preview[i];
            const num = String(i + 1).padStart(3, " ");
            console.log(`  ${num}. ${track.artist} — ${track.title}  [${track.album}]  ${formatDuration(track.duration)}`);
        }
        if (tracks.length > 10) {
            console.log(`  ... and ${tracks.length - 10} more`);
        }
        console.log("");
    }
}
// ── Main ─────────────────────────────────────────────────────────────
async function main() {
    console.log(`Connecting to Plex at ${baseUrl} ...\n`);
    if (mode === "albums") {
        await browseAlbums();
    }
    else {
        await browsePlaylists();
    }
}
main().catch((err) => {
    console.error("Failed:", err instanceof Error ? err.message : err);
    process.exit(1);
});
