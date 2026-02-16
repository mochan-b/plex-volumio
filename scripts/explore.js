"use strict";
/**
 * End-to-end exploration script that exercises the PlexService facade
 * against a real Plex server.
 *
 * Tests the full stack: PlexApiClient → LibraryParser → StreamResolver → PlexService
 *
 * Usage:
 *   npx tsx scripts/explore.ts --host 192.168.1.100 --port 32400 --token TOKEN
 *   npx tsx scripts/explore.ts --token TOKEN --search "radiohead"
 *
 * Connection details can also be set via PLEX_HOST, PLEX_PORT, PLEX_TOKEN env vars.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const api_client_js_1 = require("../src/plex/api-client.js");
const plex_service_js_1 = require("../src/plex/plex-service.js");
// ── CLI argument parsing ─────────────────────────────────────────────
function getArg(name) {
    const index = process.argv.indexOf(`--${name}`);
    return index !== -1 ? process.argv[index + 1] : undefined;
}
const host = getArg("host") ?? process.env["PLEX_HOST"] ?? "localhost";
const port = parseInt(getArg("port") ?? process.env["PLEX_PORT"] ?? "32400", 10);
const token = getArg("token") ?? process.env["PLEX_TOKEN"];
const searchQuery = getArg("search");
if (!token) {
    console.error("Error: Plex token is required.");
    console.error("  Pass --token YOUR_TOKEN or set PLEX_TOKEN env var.");
    console.error("");
    console.error("Usage:");
    console.error("  npx tsx scripts/explore.ts --token YOUR_TOKEN");
    console.error("  npx tsx scripts/explore.ts --token YOUR_TOKEN --search \"radiohead\"");
    process.exit(1);
}
// ── Helpers ──────────────────────────────────────────────────────────
function formatDuration(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
function heading(title) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`  ${title}`);
    console.log(`${"─".repeat(60)}`);
}
function ok(label) {
    console.log(`  [OK] ${label}`);
}
function fail(label, err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [FAIL] ${label}: ${msg}`);
}
// ── Main ─────────────────────────────────────────────────────────────
async function main() {
    const connection = { host, port, token };
    const client = new api_client_js_1.PlexApiClient(connection);
    const service = new plex_service_js_1.PlexService(client, connection);
    console.log(`Connecting to Plex at http://${host}:${port} ...`);
    // ── 1. Libraries ────────────────────────────────────────────────
    heading("1. Libraries");
    const libraries = await service.getLibraries();
    ok(`Found ${libraries.length} music library(ies)`);
    for (const lib of libraries) {
        console.log(`     - ${lib.title} (id: ${lib.id}, type: ${lib.type})`);
    }
    if (libraries.length === 0) {
        console.log("\nNo music libraries found — cannot continue.");
        return;
    }
    const firstLib = libraries[0];
    // ── 2. Albums ───────────────────────────────────────────────────
    heading("2. Albums");
    const albums = await service.getAlbums(firstLib.id);
    ok(`Found ${albums.length} album(s) in "${firstLib.title}"`);
    const albumPreview = albums.slice(0, 5);
    for (const album of albumPreview) {
        const year = album.year ? ` (${album.year})` : "";
        const art = album.artworkUrl ? " [has artwork]" : " [no artwork]";
        console.log(`     - ${album.artist} — ${album.title}${year}${art}`);
    }
    if (albums.length > 5) {
        console.log(`     ... and ${albums.length - 5} more`);
    }
    if (albums.length === 0) {
        console.log("\nNo albums found — skipping track tests.");
        return;
    }
    const firstAlbum = albums[0];
    // ── 3. Album tracks ────────────────────────────────────────────
    heading("3. Album Tracks");
    const tracks = await service.getAlbumTracks(firstAlbum.trackListKey);
    ok(`Found ${tracks.length} track(s) in "${firstAlbum.artist} — ${firstAlbum.title}"`);
    for (const track of tracks) {
        const art = track.artworkUrl ? " [has artwork]" : "";
        console.log(`     - ${track.title}  [${formatDuration(track.duration)}]${art}`);
    }
    if (tracks.length === 0) {
        console.log("\nNo tracks found — skipping playable track test.");
        return;
    }
    const firstTrack = tracks[0];
    // ── 4. Playable track (stream URL resolution) ──────────────────
    heading("4. Playable Track");
    try {
        const playable = await service.getPlayableTrack(firstTrack.id);
        ok(`Resolved stream URL for "${playable.title}"`);
        console.log(`     Stream URL: ${playable.streamUrl.replace(/X-Plex-Token=[^&]+/, "X-Plex-Token=████████")}`);
        console.log(`     Stream key: ${playable.streamKey}`);
        console.log(`     Duration:   ${formatDuration(playable.duration)}`);
    }
    catch (err) {
        fail("getPlayableTrack", err);
    }
    // ── 5. Artwork URL ─────────────────────────────────────────────
    heading("5. Artwork URL");
    if (firstAlbum.artworkUrl) {
        const artUrl = service.getArtworkUrl(firstAlbum.artworkUrl);
        ok(`Built artwork URL for "${firstAlbum.title}"`);
        console.log(`     ${artUrl}`);
    }
    else {
        console.log("  [SKIP] First album has no artwork path");
    }
    // ── 6. Playlists ───────────────────────────────────────────────
    heading("6. Playlists");
    try {
        const playlists = await service.getPlaylists();
        ok(`Found ${playlists.length} audio playlist(s)`);
        for (const pl of playlists.slice(0, 5)) {
            console.log(`     - ${pl.title}  (${pl.trackCount} tracks)`);
        }
        if (playlists.length > 0) {
            const firstPlaylist = playlists[0];
            const plTracks = await service.getPlaylistTracks(firstPlaylist.itemsKey);
            ok(`Fetched ${plTracks.length} track(s) from playlist "${firstPlaylist.title}"`);
            for (const t of plTracks.slice(0, 3)) {
                console.log(`     - ${t.artist} — ${t.title}  [${formatDuration(t.duration)}]`);
            }
            if (plTracks.length > 3) {
                console.log(`     ... and ${plTracks.length - 3} more`);
            }
        }
    }
    catch (err) {
        fail("getPlaylists", err);
    }
    // ── 7. Search ──────────────────────────────────────────────────
    heading("7. Search");
    const query = searchQuery ?? firstTrack.artist;
    try {
        const results = await service.search(query);
        ok(`Search for "${query}": ${results.tracks.length} track(s), ${results.albums.length} album(s)`);
        if (results.tracks.length > 0) {
            console.log("     Tracks:");
            for (const t of results.tracks.slice(0, 5)) {
                console.log(`       - ${t.artist} — ${t.title}  [${formatDuration(t.duration)}]`);
            }
            if (results.tracks.length > 5) {
                console.log(`       ... and ${results.tracks.length - 5} more`);
            }
        }
        if (results.albums.length > 0) {
            console.log("     Albums:");
            for (const a of results.albums.slice(0, 5)) {
                const year = a.year ? ` (${a.year})` : "";
                console.log(`       - ${a.artist} — ${a.title}${year}`);
            }
            if (results.albums.length > 5) {
                console.log(`       ... and ${results.albums.length - 5} more`);
            }
        }
    }
    catch (err) {
        fail("search", err);
    }
    // ── Done ───────────────────────────────────────────────────────
    heading("Done");
    console.log("  All PlexService methods exercised successfully.\n");
}
main().catch((err) => {
    console.error("\nFailed:", err instanceof Error ? err.message : err);
    process.exit(1);
});
