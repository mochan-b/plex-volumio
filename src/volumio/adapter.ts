/**
 * Volumio Adapter — integration layer that implements Volumio's music service
 * plugin interface and delegates to PlexService for content resolution.
 *
 * Uses kew promises (via libQ) as required by Volumio's plugin contract.
 * Playback is delegated to Volumio's MPD plugin via consume mode.
 */

import type {
  VolumioContext,
  VolumioCoreCommand,
  VolumioLogger,
  MpdPlugin,
  MpdCommandEntry,
  NavigationPage,
  NavigationList,
  NavigationListItem,
  QueueItem,
  SearchQuery,
  SearchResultSection,
  BrowseSource,
  VolumioState,
} from "./types.js";
import { PlexApiClient } from "../plex/api-client.js";
import { PlexService } from "../plex/plex-service.js";
import type { PlexConnection } from "../core/stream-resolver.js";
import type { Track } from "../types/index.js";

const SERVICE_NAME = "plex";
const DEFAULT_PAGE_SIZE = 100;

interface PaginationState {
  libraryKey: string | null;
  offset: number;
}

function parsePaginationUri(uri: string): PaginationState {
  const atIndex = uri.indexOf("@");
  if (atIndex === -1) {
    return { libraryKey: null, offset: 0 };
  }
  const paginationPart = uri.slice(atIndex + 1);
  const colonIndex = paginationPart.indexOf(":");
  if (colonIndex === -1) {
    return { libraryKey: paginationPart, offset: 0 };
  }
  return {
    libraryKey: paginationPart.slice(0, colonIndex),
    offset: parseInt(paginationPart.slice(colonIndex + 1), 10) || 0,
  };
}

/** Minimal interface for kew-compatible promise library (Volumio's libQ). */
export interface KewLib {
  defer(): { resolve(v: unknown): void; reject(e: unknown): void; promise: PromiseLike<unknown> };
  resolve(v?: unknown): PromiseLike<unknown>;
}

/** Convert a native Promise to a kew promise (required by Volumio). */
function jsPromiseToKew<T>(libQ: KewLib, promise: Promise<T>): unknown {
  const defer = libQ.defer();
  promise.then(
    (result: T) => defer.resolve(result),
    (error: unknown) => defer.reject(error),
  );
  return defer.promise;
}

export class VolumioAdapter {
  private commandRouter: VolumioCoreCommand;
  private logger: VolumioLogger;
  private libQ: KewLib;
  private plexService: PlexService | null = null;
  private connection: PlexConnection | null = null;
  private shuffleEnabled = false;
  private pageSize = DEFAULT_PAGE_SIZE;
  private gaplessPlayback = true;
  private crossfadeDuration = 0;

  private originalServicePushState: VolumioCoreCommand["servicePushState"] | null = null;

  private readonly browseSource: BrowseSource = {
    name: "Plex",
    uri: "plex",
    plugin_type: "music_service",
    plugin_name: SERVICE_NAME,
    albumart: "/albumart?sourceicon=music_service/plex/plex.png",
  };

  constructor(context: VolumioContext, libQ: KewLib) {
    this.commandRouter = context.coreCommand;
    this.logger = context.logger;
    this.libQ = libQ;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /** Called when Volumio starts — load config, instantiate Plex client. */
  onVolumioStart(): unknown {
    this.logger.info("[Plex] onVolumioStart");

    const host = "localhost";
    const port = 32400;
    const token = "";

    this.connection = { host, port, token };
    const apiClient = new PlexApiClient({ host, port, token });
    this.plexService = new PlexService(apiClient, this.connection);

    return this.libQ.resolve();
  }

  /** Called when the plugin is enabled — register browse source. */
  onStart(): unknown {
    this.logger.info("[Plex] onStart");
    this.commandRouter.volumioAddToBrowseSources(this.browseSource);
    this.installStateMaskHook();
    return this.libQ.resolve();
  }

  /** Called when the plugin is disabled — remove browse source, clean up. */
  onStop(): unknown {
    this.logger.info("[Plex] onStop");
    this.commandRouter.volumioRemoveToBrowseSources(this.browseSource);
    this.removeStateMaskHook();
    this.plexService = null;
    this.connection = null;
    return this.libQ.resolve();
  }

  /** Return the list of configuration files for this plugin. */
  getConfigurationFiles(): string[] {
    return ["config.json"];
  }

  // ── Configure (for external config injection in tests/setup) ───────

  /** Set up the PlexService and connection from external config. */
  configure(plexService: PlexService, connection: PlexConnection, options?: { shuffle?: boolean; pageSize?: number; gaplessPlayback?: boolean; crossfadeDuration?: number }): void {
    this.plexService = plexService;
    this.connection = connection;
    this.shuffleEnabled = options?.shuffle ?? false;
    this.pageSize = options?.pageSize ?? DEFAULT_PAGE_SIZE;
    this.gaplessPlayback = options?.gaplessPlayback ?? true;
    this.crossfadeDuration = options?.crossfadeDuration ?? 0;
  }

  // ── Browse ─────────────────────────────────────────────────────────

  /**
   * Handle browse navigation. URI scheme:
   * - plex                          → root (Artists, Albums, Playlists)
   * - plex/artists                  → artists (first page)
   * - plex/artists@{libKey}:{offset}→ artists (paginated)
   * - plex/artist/{albumsKey}       → albums by artist (+ popular tracks folder)
   * - plex/popular/{artistId}       → popular tracks for artist
   * - plex/albums                   → albums (first page)
   * - plex/albums@{libKey}:{offset} → albums (paginated)
   * - plex/album/{trackListKey}     → tracks in album
   * - plex/playlists                → list playlists
   * - plex/playlist/{itemsKey}      → tracks in playlist (first page)
   * - plex/playlist/{itemsKey}@{offset} → tracks in playlist (paginated)
   * - plex/shuffle-album/{key}      → shuffled album tracks
   * - plex/shuffle-playlist/{key}   → shuffled playlist tracks
   */
  handleBrowseUri(uri: string): unknown {
    this.logger.info(`[Plex] handleBrowseUri: ${uri}`);
    return jsPromiseToKew(this.libQ, this._handleBrowseUri(uri));
  }

  private async _handleBrowseUri(uri: string): Promise<NavigationPage> {
    const service = this.requireService();
    const parts = uri.split("/");

    // plex
    if (uri === "plex") {
      return this.browseRoot();
    }

    // plex/artists or plex/artists@{libKey}:{offset}
    if (uri === "plex/artists" || uri.startsWith("plex/artists@")) {
      return this.browseArtists(service, parsePaginationUri(uri));
    }

    // plex/albums or plex/albums@{libKey}:{offset}
    if (uri === "plex/albums" || uri.startsWith("plex/albums@")) {
      return this.browseAlbums(service, parsePaginationUri(uri));
    }

    // plex/playlists
    if (uri === "plex/playlists") {
      return this.browsePlaylists(service);
    }

    // plex/artist/{albumsKey...}  (key may contain slashes, encoded as __)
    if (parts[1] === "artist" && parts[2]) {
      const albumsKey = decodePathSegment(parts.slice(2).join("/"));
      return this.browseArtist(service, albumsKey);
    }

    // plex/popular/{artistId}
    if (parts[1] === "popular" && parts[2]) {
      return this.browsePopularTracks(service, parts[2]);
    }

    // plex/shuffle-album/{trackListKey...}
    if (parts[1] === "shuffle-album" && parts[2]) {
      const trackListKey = decodePathSegment(parts.slice(2).join("/"));
      return this.browseShuffleAlbum(service, trackListKey);
    }

    // plex/shuffle-playlist/{itemsKey...}
    if (parts[1] === "shuffle-playlist" && parts[2]) {
      const itemsKey = decodePathSegment(parts.slice(2).join("/"));
      return this.browseShufflePlaylist(service, itemsKey);
    }

    // plex/album/{trackListKey...}  (key may contain slashes, encoded as __)
    if (parts[1] === "album" && parts[2]) {
      const trackListKey = decodePathSegment(parts.slice(2).join("/"));
      return this.browseAlbum(service, trackListKey);
    }

    // plex/playlist/{itemsKey...} or plex/playlist/{itemsKey...}@{offset}
    if (parts[1] === "playlist" && parts[2]) {
      const raw = parts.slice(2).join("/");
      const atIndex = raw.indexOf("@");
      if (atIndex === -1) {
        return this.browsePlaylist(service, decodePathSegment(raw), 0);
      }
      const itemsKey = decodePathSegment(raw.slice(0, atIndex));
      const offset = parseInt(raw.slice(atIndex + 1), 10) || 0;
      return this.browsePlaylist(service, itemsKey, offset);
    }

    throw new Error(`Unknown browse URI: ${uri}`);
  }

  private browseRoot(): NavigationPage {
    const items: NavigationListItem[] = [
      {
        service: SERVICE_NAME,
        type: "folder",
        title: "Artists",
        uri: "plex/artists",
        icon: "fa fa-microphone",
      },
      {
        service: SERVICE_NAME,
        type: "folder",
        title: "Albums",
        uri: "plex/albums",
        icon: "fa fa-music",
      },
      {
        service: SERVICE_NAME,
        type: "folder",
        title: "Playlists",
        uri: "plex/playlists",
        icon: "fa fa-list",
      },
    ];

    return {
      navigation: {
        prev: { uri: "/" },
        lists: [
          {
            title: "Plex Music",
            icon: "fa fa-server",
            availableListViews: ["list", "grid"],
            items,
          },
        ],
      },
    };
  }

  private async browseArtists(service: PlexService, pagination: PaginationState): Promise<NavigationPage> {
    const libraries = await service.getLibraries();
    let libraryKey = pagination.libraryKey;
    if (libraryKey === null) {
      libraryKey = libraries[0]?.id ?? null;
      if (!libraryKey) {
        return { navigation: { prev: { uri: "plex" }, lists: [{ title: "Artists", icon: "fa fa-microphone", availableListViews: ["list", "grid"], items: [] }] } };
      }
    }

    const result = await service.getArtistsPaginated(libraryKey, pagination.offset, this.pageSize);

    const items: NavigationListItem[] = [];

    if (pagination.offset > 0) {
      const prevOffset = Math.max(0, pagination.offset - this.pageSize);
      const prevUri = prevOffset === 0
        ? "plex/artists"
        : `plex/artists@${libraryKey}:${prevOffset}`;
      items.push({
        service: SERVICE_NAME,
        type: "item",
        title: "Previous page",
        uri: prevUri,
        icon: "fa fa-arrow-circle-up",
      });
    }

    items.push(...result.items.map((artist) => ({
      service: SERVICE_NAME,
      type: "folder" as const,
      title: artist.title,
      albumart: artist.artworkUrl ? service.getArtworkUrl(artist.artworkUrl) : undefined,
      uri: `plex/artist/${encodePathSegment(artist.albumsKey)}`,
    })));

    const nextOffset = pagination.offset + result.items.length;
    if (nextOffset < result.totalSize) {
      items.push({
        service: SERVICE_NAME,
        type: "item",
        title: "Load more...",
        uri: `plex/artists@${libraryKey}:${nextOffset}`,
        icon: "fa fa-arrow-circle-down",
      });
    } else {
      const currentLibIndex = libraries.findIndex((l) => l.id === libraryKey);
      const nextLib = libraries[currentLibIndex + 1];
      if (nextLib) {
        items.push({
          service: SERVICE_NAME,
          type: "item",
          title: "Load more...",
          uri: `plex/artists@${nextLib.id}:0`,
          icon: "fa fa-arrow-circle-down",
        });
      }
    }

    return {
      navigation: {
        prev: { uri: "plex" },
        lists: [
          {
            title: "Artists",
            icon: "fa fa-microphone",
            availableListViews: ["list", "grid"],
            items,
          },
        ],
      },
    };
  }

  private async browseArtist(service: PlexService, albumsKey: string): Promise<NavigationPage> {
    const albums = await service.getArtistAlbums(albumsKey);

    // Extract artist ratingKey from albumsKey (e.g. "/library/metadata/123/children" → "123")
    const artistId = albumsKey.split("/").slice(-2, -1)[0];

    const items: NavigationListItem[] = albums.map((album) => ({
      service: SERVICE_NAME,
      type: "folder" as const,
      title: album.title,
      artist: album.artist,
      albumart: album.artworkUrl ? service.getArtworkUrl(album.artworkUrl) : undefined,
      uri: `plex/album/${encodePathSegment(album.trackListKey)}`,
    }));

    // Add "Popular Tracks" folder after the albums
    if (artistId) {
      items.push({
        service: SERVICE_NAME,
        type: "folder",
        title: "Popular Tracks",
        uri: `plex/popular/${artistId}`,
        icon: "fa fa-fire",
      });
    }

    return {
      navigation: {
        prev: { uri: "plex/artists" },
        lists: [
          {
            title: albums[0]?.artist ?? "Artist",
            availableListViews: ["list", "grid"],
            items,
          },
        ],
      },
    };
  }

  private async browsePopularTracks(service: PlexService, artistId: string): Promise<NavigationPage> {
    const tracks = await service.getPopularTracks(artistId);

    const items: NavigationListItem[] = tracks.map((track) =>
      this.trackToNavItem(service, track),
    );

    return {
      navigation: {
        prev: { uri: `plex/artist/${encodePathSegment(`/library/metadata/${artistId}/children`)}` },
        lists: [
          {
            title: "Popular Tracks",
            icon: "fa fa-fire",
            availableListViews: ["list"],
            items,
          },
        ],
      },
    };
  }

  private async browseAlbums(service: PlexService, pagination: PaginationState): Promise<NavigationPage> {
    const libraries = await service.getLibraries();
    let libraryKey = pagination.libraryKey;
    if (libraryKey === null) {
      libraryKey = libraries[0]?.id ?? null;
      if (!libraryKey) {
        return { navigation: { prev: { uri: "plex" }, lists: [{ title: "Albums", availableListViews: ["list", "grid"], items: [] }] } };
      }
    }

    const result = await service.getAlbumsPaginated(libraryKey, pagination.offset, this.pageSize);

    const items: NavigationListItem[] = [];

    if (pagination.offset > 0) {
      const prevOffset = Math.max(0, pagination.offset - this.pageSize);
      const prevUri = prevOffset === 0
        ? "plex/albums"
        : `plex/albums@${libraryKey}:${prevOffset}`;
      items.push({
        service: SERVICE_NAME,
        type: "item",
        title: "Previous page",
        uri: prevUri,
        icon: "fa fa-arrow-circle-up",
      });
    }

    items.push(...result.items.map((album) => ({
      service: SERVICE_NAME,
      type: "folder" as const,
      title: album.title,
      artist: album.artist,
      albumart: album.artworkUrl ? service.getArtworkUrl(album.artworkUrl) : undefined,
      uri: `plex/album/${encodePathSegment(album.trackListKey)}`,
    })));

    const nextOffset = pagination.offset + result.items.length;
    if (nextOffset < result.totalSize) {
      items.push({
        service: SERVICE_NAME,
        type: "item",
        title: "Load more...",
        uri: `plex/albums@${libraryKey}:${nextOffset}`,
        icon: "fa fa-arrow-circle-down",
      });
    } else {
      const currentLibIndex = libraries.findIndex((l) => l.id === libraryKey);
      const nextLib = libraries[currentLibIndex + 1];
      if (nextLib) {
        items.push({
          service: SERVICE_NAME,
          type: "item",
          title: "Load more...",
          uri: `plex/albums@${nextLib.id}:0`,
          icon: "fa fa-arrow-circle-down",
        });
      }
    }

    return {
      navigation: {
        prev: { uri: "plex" },
        lists: [
          {
            title: "Albums",
            availableListViews: ["list", "grid"],
            items,
          },
        ],
      },
    };
  }

  private async browseAlbum(service: PlexService, trackListKey: string): Promise<NavigationPage> {
    const tracks = await service.getAlbumTracks(trackListKey);

    const lists: NavigationList[] = [];

    if (this.shuffleEnabled) {
      lists.push({
        availableListViews: ["list"],
        items: [{
          service: SERVICE_NAME,
          type: "folder",
          title: "Shuffle",
          uri: `plex/shuffle-album/${encodePathSegment(trackListKey)}`,
          icon: "fa fa-random",
        }],
      });
    }

    lists.push({
      title: tracks[0]?.album ?? "Album",
      availableListViews: ["list"],
      items: tracks.map((track) => this.trackToNavItem(service, track)),
    });

    return {
      navigation: {
        prev: { uri: "plex/albums" },
        lists,
      },
    };
  }

  private async browsePlaylists(service: PlexService): Promise<NavigationPage> {
    const playlists = await service.getPlaylists();

    const items: NavigationListItem[] = playlists.map((pl) => ({
      service: SERVICE_NAME,
      type: "folder",
      title: pl.title,
      uri: `plex/playlist/${encodePathSegment(pl.itemsKey)}`,
      icon: "fa fa-list",
    }));

    return {
      navigation: {
        prev: { uri: "plex" },
        lists: [
          {
            title: "Playlists",
            icon: "fa fa-list",
            availableListViews: ["list"],
            items,
          },
        ],
      },
    };
  }

  private async browsePlaylist(service: PlexService, itemsKey: string, offset: number): Promise<NavigationPage> {
    const result = await service.getPlaylistTracksPaginated(itemsKey, offset, this.pageSize);

    const lists: NavigationList[] = [];

    // Navigation items (previous page, shuffle) in their own list
    const navItems: NavigationListItem[] = [];

    if (offset > 0) {
      const prevOffset = Math.max(0, offset - this.pageSize);
      const prevUri = prevOffset === 0
        ? `plex/playlist/${encodePathSegment(itemsKey)}`
        : `plex/playlist/${encodePathSegment(itemsKey)}@${prevOffset}`;
      navItems.push({
        service: SERVICE_NAME,
        type: "item",
        title: "Previous page",
        uri: prevUri,
        icon: "fa fa-arrow-circle-up",
      });
    }

    if (this.shuffleEnabled && offset === 0) {
      navItems.push({
        service: SERVICE_NAME,
        type: "folder",
        title: "Shuffle",
        uri: `plex/shuffle-playlist/${encodePathSegment(itemsKey)}`,
        icon: "fa fa-random",
      });
    }

    if (navItems.length > 0) {
      lists.push({
        availableListViews: ["list"],
        items: navItems,
      });
    }

    // Tracks in their own list
    lists.push({
      title: "Playlist",
      availableListViews: ["list"],
      items: result.items.map((track) => this.trackToNavItem(service, track)),
    });

    const nextOffset = offset + result.items.length;
    if (nextOffset < result.totalSize) {
      lists.push({
        availableListViews: ["list"],
        items: [{
          service: SERVICE_NAME,
          type: "item",
          title: "Load more...",
          uri: `plex/playlist/${encodePathSegment(itemsKey)}@${nextOffset}`,
          icon: "fa fa-arrow-circle-down",
        }],
      });
    }

    return {
      navigation: {
        prev: { uri: "plex/playlists" },
        lists,
      },
    };
  }

  private async browseShuffleAlbum(service: PlexService, trackListKey: string): Promise<NavigationPage> {
    const tracks = await service.getAlbumTracks(trackListKey);
    shuffleArray(tracks);

    const items: NavigationListItem[] = tracks.map((track) =>
      this.trackToNavItem(service, track),
    );

    return {
      navigation: {
        prev: { uri: `plex/album/${encodePathSegment(trackListKey)}` },
        lists: [
          {
            title: "Shuffle",
            icon: "fa fa-random",
            availableListViews: ["list"],
            items,
          },
        ],
      },
    };
  }

  private async browseShufflePlaylist(service: PlexService, itemsKey: string): Promise<NavigationPage> {
    const tracks = await service.getPlaylistTracks(itemsKey);
    shuffleArray(tracks);

    const items: NavigationListItem[] = tracks.map((track) =>
      this.trackToNavItem(service, track),
    );

    return {
      navigation: {
        prev: { uri: `plex/playlist/${encodePathSegment(itemsKey)}` },
        lists: [
          {
            title: "Shuffle",
            icon: "fa fa-random",
            availableListViews: ["list"],
            items,
          },
        ],
      },
    };
  }

  private trackToNavItem(service: PlexService, track: Track): NavigationListItem {
    return {
      service: SERVICE_NAME,
      type: "song",
      title: track.title,
      artist: track.artist,
      album: track.album,
      albumart: track.artworkUrl ? service.getArtworkUrl(track.artworkUrl) : undefined,
      uri: `plex/track/${track.id}`,
      duration: Math.round(track.duration / 1000),
    };
  }

  // ── Explode (resolve URI to queue items) ───────────────────────────

  /** Resolve a URI to QueueItem[] for Volumio's queue. */
  explodeUri(uri: string): unknown {
    this.logger.info(`[Plex] explodeUri: ${uri}`);
    return jsPromiseToKew(this.libQ, this._explodeUri(uri));
  }

  private async _explodeUri(uri: string): Promise<QueueItem[]> {
    const service = this.requireService();
    const parts = uri.split("/");

    // plex/track/{trackId}
    if (parts[1] === "track" && parts[2]) {
      const playable = await service.getPlayableTrack(parts[2]);
      return [this.trackToQueueItem(service, playable)];
    }

    // plex/popular/{artistId}
    if (parts[1] === "popular" && parts[2]) {
      const tracks = await service.getPopularTracks(parts[2]);
      return tracks.map((track) => this.trackToQueueItem(service, track));
    }

    // plex/shuffle-album/{trackListKey...}
    if (parts[1] === "shuffle-album" && parts[2]) {
      const trackListKey = decodePathSegment(parts.slice(2).join("/"));
      const tracks = await service.getAlbumTracks(trackListKey);
      shuffleArray(tracks);
      return tracks.map((track) => this.trackToQueueItem(service, track));
    }

    // plex/shuffle-playlist/{itemsKey...}
    if (parts[1] === "shuffle-playlist" && parts[2]) {
      const itemsKey = decodePathSegment(parts.slice(2).join("/"));
      const tracks = await service.getPlaylistTracks(itemsKey);
      shuffleArray(tracks);
      return tracks.map((track) => this.trackToQueueItem(service, track));
    }

    // plex/album/{trackListKey...}
    if (parts[1] === "album" && parts[2]) {
      const trackListKey = decodePathSegment(parts.slice(2).join("/"));
      const tracks = await service.getAlbumTracks(trackListKey);
      return tracks.map((track) => this.trackToQueueItem(service, track));
    }

    // plex/playlist/{itemsKey...}
    if (parts[1] === "playlist" && parts[2]) {
      const itemsKey = decodePathSegment(parts.slice(2).join("/"));
      const tracks = await service.getPlaylistTracks(itemsKey);
      return tracks.map((track) => this.trackToQueueItem(service, track));
    }

    throw new Error(`Cannot explode URI: ${uri}`);
  }

  private trackToQueueItem(service: PlexService, track: Track): QueueItem {
    return {
      uri: `plex/track/${track.id}/stream/${encodePathSegment(track.streamKey)}`,
      service: SERVICE_NAME,
      name: track.title,
      artist: track.artist,
      album: track.album,
      albumart: track.artworkUrl ? service.getArtworkUrl(track.artworkUrl) : "",
      duration: Math.round(track.duration / 1000),
      type: "track",
    };
  }

  // ── Goto (navigate to artist/album of playing track) ───────────────

  /** Navigate to the artist or album browse page for the currently playing track. */
  goto(data: { type: "album" | "artist"; uri?: string }): unknown {
    this.logger.info(`[Plex] goto: ${data.type}`);
    return jsPromiseToKew(this.libQ, this._goto(data));
  }

  private async _goto(data: { type: "album" | "artist"; uri?: string }): Promise<NavigationPage> {
    const service = this.requireService();
    const uri = data.uri ?? "";

    // Extract track ID from "plex/track/{id}/stream/..."
    const match = uri.match(/^plex\/track\/(\d+)\//);
    if (!match) {
      throw new Error(`Cannot navigate: track URI does not contain a track ID (uri=${uri})`);
    }
    const trackId = match[1]!;

    const { albumBrowseKey, artistBrowseKey } = await service.getTrackBrowseKeys(trackId);

    if (data.type === "album") {
      return this._handleBrowseUri(`plex/album/${encodePathSegment(albumBrowseKey)}`);
    } else {
      return this._handleBrowseUri(`plex/artist/${encodePathSegment(artistBrowseKey)}`);
    }
  }

  // ── Playback (delegates to MPD via consume mode) ───────────────────

  /** Clear queue, add track, and start playback via MPD. */
  clearAddPlayTrack(track: QueueItem): unknown {
    this.logger.info(`[Plex] clearAddPlayTrack: ${track.name}`);
    return jsPromiseToKew(this.libQ, this._clearAddPlayTrack(track));
  }

  private async _clearAddPlayTrack(track: QueueItem): Promise<void> {
    const mpdPlugin = this.getMpdPlugin();
    const streamUrl = this.resolveStreamUrl(track.uri);

    // Clear MPD queue
    await mpdPlugin.sendMpdCommand("stop", []);
    await mpdPlugin.sendMpdCommand("clear", []);

    // Set crossfade (0 = disabled; only applied when gapless is on)
    const xfade = this.gaplessPlayback ? this.crossfadeDuration : 0;
    await mpdPlugin.sendMpdCommand(`crossfade ${xfade}`, []);

    // Try load first (handles playlists/streams), fall back to addid
    let songId: string | undefined;
    try {
      await mpdPlugin.sendMpdCommand(`load "${streamUrl}"`, []);
    } catch {
      const resp = (await mpdPlugin.sendMpdCommand(`addid "${streamUrl}"`, [])) as {
        Id?: string;
      };
      songId = resp?.Id;
    }

    // Set metadata tags so MPD state pushes carry correct info
    if (songId !== undefined) {
      await this.mpdAddTags(mpdPlugin, songId, track);
    }

    // Set consume mode and play
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);
    await mpdPlugin.sendMpdCommand("play", []);
  }

  /** Pre-buffer the next track into the MPD queue for gapless playback. */
  prefetch(track: QueueItem): unknown {
    this.logger.info(`[Plex] prefetch: ${track.name}`);
    return jsPromiseToKew(this.libQ, this._prefetch(track));
  }

  private async _prefetch(track: QueueItem): Promise<void> {
    if (!this.gaplessPlayback) {
      this.commandRouter.stateMachine.prefetchDone = false;
      return;
    }

    const mpdPlugin = this.getMpdPlugin();
    const streamUrl = this.resolveStreamUrl(track.uri);

    try {
      const resp = (await mpdPlugin.sendMpdCommand(`addid "${streamUrl}"`, [])) as { Id?: string };
      const songId = resp?.Id;

      if (songId !== undefined) {
        await this.mpdAddTags(mpdPlugin, songId, track);
      }

      await mpdPlugin.sendMpdCommand("consume 1", []);
      this.commandRouter.stateMachine.prefetchDone = true;
      this.logger.info(`[Plex] Prefetched next track: ${track.name}`);
    } catch (err) {
      this.logger.error(`[Plex] Prefetch failed: ${err}`);
      this.commandRouter.stateMachine.prefetchDone = false;
    }
  }

  /** Set title/artist/album tags on an MPD queue entry by song ID. */
  private async mpdAddTags(
    mpdPlugin: MpdPlugin,
    songId: string,
    track: QueueItem,
  ): Promise<void> {
    const commands: MpdCommandEntry[] = [
      { command: "addtagid", parameters: [songId, "title", track.name] },
      { command: "addtagid", parameters: [songId, "album", track.album] },
      { command: "addtagid", parameters: [songId, "artist", track.artist] },
    ];
    await mpdPlugin.sendMpdCommandArray(commands);
  }

  /** Resolve a queue item URI to the actual stream URL for MPD.
   *  Accepts both plex/track/{id}/stream/{key} and legacy plex/stream/{key} URIs. */
  private resolveStreamUrl(uri: string): string {
    // New format: plex/track/{id}/stream/{encodedKey}
    const newPrefix = "plex/track/";
    if (uri.startsWith(newPrefix)) {
      const streamIdx = uri.indexOf("/stream/");
      if (streamIdx !== -1) {
        const streamKey = decodePathSegment(uri.slice(streamIdx + "/stream/".length));
        return this.requireService().getStreamUrl(streamKey);
      }
    }
    // Legacy format: plex/stream/{encodedKey}
    const legacyPrefix = "plex/stream/";
    if (uri.startsWith(legacyPrefix)) {
      const streamKey = decodePathSegment(uri.slice(legacyPrefix.length));
      return this.requireService().getStreamUrl(streamKey);
    }
    return uri;
  }

  /** Stop playback. */
  stop(): unknown {
    this.logger.info("[Plex] stop");
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);
    return this.getMpdPlugin().stop();
  }

  /** Pause playback. */
  pause(): unknown {
    this.logger.info("[Plex] pause");
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);
    return this.getMpdPlugin().pause();
  }

  /** Resume playback. */
  resume(): unknown {
    this.logger.info("[Plex] resume");
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);
    return this.getMpdPlugin().resume();
  }

  /** Seek to a position in milliseconds. */
  seek(position: number): unknown {
    this.logger.info(`[Plex] seek: ${position}ms`);
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);
    return this.getMpdPlugin().seek(position);
  }

  /** Skip to the next track. */
  next(): unknown {
    this.logger.info("[Plex] next");
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);
    return this.getMpdPlugin().next();
  }

  /** Go back to the previous track. */
  previous(): unknown {
    this.logger.info("[Plex] previous");
    this.commandRouter.stateMachine.setConsumeUpdateService(undefined);
    return this.commandRouter.stateMachine.previous();
  }

  // ── Search ─────────────────────────────────────────────────────────

  /** Search Plex for tracks and albums matching the query. */
  search(query: SearchQuery): unknown {
    this.logger.info(`[Plex] search: ${query.value}`);
    return jsPromiseToKew(this.libQ, this._search(query));
  }

  private async _search(query: SearchQuery): Promise<SearchResultSection[]> {
    const service = this.requireService();
    const results = await service.search(query.value);
    const sections: SearchResultSection[] = [];

    if (results.tracks.length > 0) {
      sections.push({
        title: "Plex Tracks",
        availableListViews: ["list"],
        items: results.tracks.map((track) => this.trackToNavItem(service, track)),
      });
    }

    if (results.artists.length > 0) {
      sections.push({
        title: "Plex Artists",
        availableListViews: ["list", "grid"],
        items: results.artists.map((artist) => ({
          service: SERVICE_NAME,
          type: "folder" as const,
          title: artist.title,
          albumart: artist.artworkUrl ? service.getArtworkUrl(artist.artworkUrl) : undefined,
          uri: `plex/artist/${encodePathSegment(artist.albumsKey)}`,
        })),
      });
    }

    if (results.albums.length > 0) {
      sections.push({
        title: "Plex Albums",
        availableListViews: ["list", "grid"],
        items: results.albums.map((album) => ({
          service: SERVICE_NAME,
          type: "folder" as const,
          title: album.title,
          artist: album.artist,
          albumart: album.artworkUrl ? service.getArtworkUrl(album.artworkUrl) : undefined,
          uri: `plex/album/${encodePathSegment(album.trackListKey)}`,
        })),
      });
    }

    return sections;
  }

  // ── State push ─────────────────────────────────────────────────────

  /** Push playback state to Volumio's state machine. */
  pushState(state: VolumioState): void {
    this.commandRouter.servicePushState(state, SERVICE_NAME);
  }

  // ── Internal helpers ───────────────────────────────────────────────

  private requireService(): PlexService {
    if (!this.plexService) {
      throw new Error("PlexService not initialized — call onVolumioStart first");
    }
    return this.plexService;
  }

  private getMpdPlugin(): MpdPlugin {
    const plugin = this.commandRouter.pluginManager.getPlugin("music_service", "mpd");
    if (!plugin) {
      throw new Error("MPD plugin not found");
    }
    return plugin;
  }

  /**
   * Wrap commandRouter.servicePushState so that any state containing a
   * Plex token in its URI is sanitised before it reaches the state machine
   * (and its logging).  MPD reports back the real stream URL it was given,
   * so this is the only place we can intercept it.
   */
  private installStateMaskHook(): void {
    if (this.originalServicePushState) return; // already installed
    const original = this.commandRouter.servicePushState.bind(this.commandRouter);
    this.originalServicePushState = original;
    this.commandRouter.servicePushState = (state: VolumioState, serviceName: string) => {
      if (state.uri && state.uri.includes("X-Plex-Token")) {
        state = { ...state, uri: state.uri.replace(/X-Plex-Token=[^&]+/, "X-Plex-Token=████████") };
      }
      return original(state, serviceName);
    };
  }

  private removeStateMaskHook(): void {
    if (this.originalServicePushState) {
      this.commandRouter.servicePushState = this.originalServicePushState;
      this.originalServicePushState = null;
    }
  }
}

// ── URI encoding helpers ─────────────────────────────────────────────
// Plex keys contain slashes (e.g. "/library/metadata/1001/children").
// We encode them for safe embedding in our URI scheme by replacing / with __.

function encodePathSegment(key: string): string {
  return key.replace(/\//g, "__");
}

function decodePathSegment(encoded: string): string {
  return encoded.replace(/__/g, "/");
}

/** Fisher-Yates in-place shuffle. */
function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j]!, array[i]!];
  }
}
