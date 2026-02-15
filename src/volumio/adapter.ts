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
  NavigationPage,
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

  private readonly browseSource: BrowseSource = {
    name: "Plex",
    uri: "plex",
    plugin_type: "music_service",
    plugin_name: SERVICE_NAME,
    albumart: "/albumart?sourceicon=music_service/plex/plex.svg",
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
    return this.libQ.resolve();
  }

  /** Called when the plugin is disabled — remove browse source, clean up. */
  onStop(): unknown {
    this.logger.info("[Plex] onStop");
    this.commandRouter.volumioRemoveToBrowseSources(this.browseSource);
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
  configure(plexService: PlexService, connection: PlexConnection): void {
    this.plexService = plexService;
    this.connection = connection;
  }

  // ── Browse ─────────────────────────────────────────────────────────

  /**
   * Handle browse navigation. URI scheme:
   * - plex                          → root (Artists, Albums, Playlists)
   * - plex/artists                  → all artists
   * - plex/artist/{albumsKey}       → albums by artist
   * - plex/albums                   → all albums
   * - plex/album/{trackListKey}     → tracks in album
   * - plex/playlists                → list playlists
   * - plex/playlist/{itemsKey}      → tracks in playlist
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

    // plex/artists
    if (uri === "plex/artists") {
      return this.browseArtists(service);
    }

    // plex/albums
    if (uri === "plex/albums") {
      return this.browseAlbums(service);
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

    // plex/album/{trackListKey...}  (key may contain slashes, encoded as __)
    if (parts[1] === "album" && parts[2]) {
      const trackListKey = decodePathSegment(parts.slice(2).join("/"));
      return this.browseAlbum(service, trackListKey);
    }

    // plex/playlist/{itemsKey...}
    if (parts[1] === "playlist" && parts[2]) {
      const itemsKey = decodePathSegment(parts.slice(2).join("/"));
      return this.browsePlaylist(service, itemsKey);
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

  private async browseArtists(service: PlexService): Promise<NavigationPage> {
    const artists = await service.getAllArtists();

    const items: NavigationListItem[] = artists.map((artist) => ({
      service: SERVICE_NAME,
      type: "folder",
      title: artist.title,
      albumart: artist.artworkUrl ? service.getArtworkUrl(artist.artworkUrl) : undefined,
      uri: `plex/artist/${encodePathSegment(artist.albumsKey)}`,
    }));

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

    const items: NavigationListItem[] = albums.map((album) => ({
      service: SERVICE_NAME,
      type: "folder",
      title: album.title,
      artist: album.artist,
      albumart: album.artworkUrl ? service.getArtworkUrl(album.artworkUrl) : undefined,
      uri: `plex/album/${encodePathSegment(album.trackListKey)}`,
    }));

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

  private async browseAlbums(service: PlexService): Promise<NavigationPage> {
    const albums = await service.getAllAlbums();

    const items: NavigationListItem[] = albums.map((album) => ({
      service: SERVICE_NAME,
      type: "folder",
      title: album.title,
      artist: album.artist,
      albumart: album.artworkUrl ? service.getArtworkUrl(album.artworkUrl) : undefined,
      uri: `plex/album/${encodePathSegment(album.trackListKey)}`,
    }));

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

    const items: NavigationListItem[] = tracks.map((track) =>
      this.trackToNavItem(service, track),
    );

    return {
      navigation: {
        prev: { uri: "plex" },
        lists: [
          {
            title: tracks[0]?.album ?? "Album",
            availableListViews: ["list"],
            items,
          },
        ],
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

  private async browsePlaylist(service: PlexService, itemsKey: string): Promise<NavigationPage> {
    const tracks = await service.getPlaylistTracks(itemsKey);

    const items: NavigationListItem[] = tracks.map((track) =>
      this.trackToNavItem(service, track),
    );

    return {
      navigation: {
        prev: { uri: "plex/playlists" },
        lists: [
          {
            title: "Playlist",
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
      return [this.trackToQueueItem(service, playable, playable.streamUrl)];
    }

    // plex/album/{trackListKey...}
    if (parts[1] === "album" && parts[2]) {
      const trackListKey = decodePathSegment(parts.slice(2).join("/"));
      const tracks = await service.getAlbumTracks(trackListKey);
      return Promise.all(
        tracks.map(async (track) => {
          const playable = await service.getPlayableTrack(track.id);
          return this.trackToQueueItem(service, playable, playable.streamUrl);
        }),
      );
    }

    // plex/playlist/{itemsKey...}
    if (parts[1] === "playlist" && parts[2]) {
      const itemsKey = decodePathSegment(parts.slice(2).join("/"));
      const tracks = await service.getPlaylistTracks(itemsKey);
      return Promise.all(
        tracks.map(async (track) => {
          const playable = await service.getPlayableTrack(track.id);
          return this.trackToQueueItem(service, playable, playable.streamUrl);
        }),
      );
    }

    throw new Error(`Cannot explode URI: ${uri}`);
  }

  private trackToQueueItem(service: PlexService, track: Track, streamUrl: string): QueueItem {
    return {
      uri: streamUrl,
      service: SERVICE_NAME,
      name: track.title,
      artist: track.artist,
      album: track.album,
      albumart: track.artworkUrl ? service.getArtworkUrl(track.artworkUrl) : "",
      duration: Math.round(track.duration / 1000),
      type: "track",
    };
  }

  // ── Playback (delegates to MPD via consume mode) ───────────────────

  /** Clear queue, add track, and start playback via MPD. */
  clearAddPlayTrack(track: QueueItem): unknown {
    this.logger.info(`[Plex] clearAddPlayTrack: ${track.name}`);
    return jsPromiseToKew(this.libQ, this._clearAddPlayTrack(track));
  }

  private async _clearAddPlayTrack(track: QueueItem): Promise<void> {
    const mpdPlugin = this.getMpdPlugin();

    // Set consume mode so Volumio's MPD handles audio
    this.commandRouter.stateMachine.setConsumeUpdateService("mpd", true, false);

    // Clear MPD queue, add track, and play
    await mpdPlugin.sendMpdCommand("stop", []);
    await mpdPlugin.sendMpdCommand("clear", []);
    await mpdPlugin.sendMpdCommand("addid", [track.uri]);
    await mpdPlugin.sendMpdCommand("play", []);

    // Push initial state
    this.pushState({
      status: "play",
      service: SERVICE_NAME,
      title: track.name,
      artist: track.artist,
      album: track.album,
      albumart: track.albumart,
      uri: track.uri,
      seek: 0,
      duration: track.duration,
    });
  }

  /** Stop playback. */
  stop(): unknown {
    this.logger.info("[Plex] stop");
    const mpdPlugin = this.getMpdPlugin();
    return mpdPlugin.sendMpdCommand("stop", []);
  }

  /** Pause playback. */
  pause(): unknown {
    this.logger.info("[Plex] pause");
    const mpdPlugin = this.getMpdPlugin();
    return mpdPlugin.sendMpdCommand("pause", []);
  }

  /** Resume playback. */
  resume(): unknown {
    this.logger.info("[Plex] resume");
    const mpdPlugin = this.getMpdPlugin();
    return mpdPlugin.sendMpdCommand("play", []);
  }

  /** Seek to a position in milliseconds. */
  seek(position: number): unknown {
    this.logger.info(`[Plex] seek: ${position}ms`);
    const mpdPlugin = this.getMpdPlugin();
    const seconds = Math.round(position / 1000);
    return mpdPlugin.sendMpdCommand("seek", ["0", String(seconds)]);
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
