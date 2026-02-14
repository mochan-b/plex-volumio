/**
 * Smoke test — run against a real Plex server to verify the API client.
 *
 * Usage:
 *   npx tsx src/plex/smoke-test.ts <host> <port> <token>
 *
 * Example:
 *   npx tsx src/plex/smoke-test.ts 192.168.1.50 32400 your-plex-token
 */

import { PlexApiClient } from "./api-client.js";
import { parseLibraries, parseAlbums, parseTracks, parsePlaylists } from "../core/parser.js";

const [host, portStr, token] = process.argv.slice(2);

if (!host || !portStr || !token) {
  console.error("Usage: npx tsx src/plex/smoke-test.ts <host> <port> <token>");
  process.exit(1);
}

const client = new PlexApiClient({ host, port: Number(portStr), token });

async function main() {
  // 1. Libraries
  console.log("--- Libraries ---");
  const rawLibraries = await client.getLibraries();
  const libraries = parseLibraries(rawLibraries);
  console.log(`Found ${libraries.length} music library(ies):`);
  for (const lib of libraries) {
    console.log(`  [${lib.id}] ${lib.title}`);
  }

  // 2. Albums from first library
  const firstLib = libraries[0];
  if (!firstLib) {
    console.log("\nNo music libraries found — skipping albums/tracks.");
    return;
  }

  console.log(`\n--- Albums in "${firstLib.title}" ---`);
  const rawAlbums = await client.getAlbums(firstLib.id);
  const albums = parseAlbums(rawAlbums);
  console.log(`Found ${albums.length} album(s) (showing first 5):`);
  for (const album of albums.slice(0, 5)) {
    console.log(`  [${album.id}] ${album.artist} — ${album.title} (${album.year ?? "n/a"})`);
  }

  // 3. Tracks from first album
  const firstAlbum = albums[0];
  if (!firstAlbum) {
    console.log("\nNo albums found — skipping tracks.");
    return;
  }

  console.log(`\n--- Tracks in "${firstAlbum.title}" ---`);
  const rawTracks = await client.getTracks(firstAlbum.trackListKey);
  const tracks = parseTracks(rawTracks);
  console.log(`Found ${tracks.length} track(s):`);
  for (const track of tracks) {
    const mins = Math.floor(track.duration / 60000);
    const secs = Math.floor((track.duration % 60000) / 1000).toString().padStart(2, "0");
    console.log(`  [${track.id}] ${track.title} (${mins}:${secs})`);
    console.log(`         streamKey: ${track.streamKey}`);
  }

  // 4. Playlists
  console.log("\n--- Playlists ---");
  const rawPlaylists = await client.getPlaylists();
  const playlists = parsePlaylists(rawPlaylists);
  console.log(`Found ${playlists.length} audio playlist(s):`);
  for (const pl of playlists) {
    console.log(`  [${pl.id}] ${pl.title} (${pl.trackCount} tracks)`);
  }
}

main().catch((err: unknown) => {
  console.error("\nError:", err);
  process.exit(1);
});
