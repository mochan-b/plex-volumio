import { describe, it, expect, beforeEach, vi } from "vitest";
import { VolumioAdapter } from "./adapter.js";
import type { KewLib } from "./adapter.js";
import type { PlexService, PlayableTrack } from "../plex/plex-service.js";
import type { PlexConnection } from "../core/stream-resolver.js";
import type { Library, Artist, Album, Track, Playlist } from "../types/index.js";
import type {
  VolumioContext,
  VolumioCoreCommand,
  VolumioLogger,
  MpdPlugin,
  NavigationPage,
  QueueItem,
  SearchResultSection,
} from "./types.js";

// ── Mock kew (simple native-Promise-based stand-in) ──────────────────

function createMockLibQ(): KewLib {
  return {
    defer: () => {
      let _resolve: (v: unknown) => void;
      let _reject: (e: unknown) => void;
      const promise = new Promise((res, rej) => {
        _resolve = res;
        _reject = rej;
      });
      return {
        resolve: (v: unknown) => _resolve!(v),
        reject: (e: unknown) => _reject!(e),
        promise,
      };
    },
    resolve: (v?: unknown) => Promise.resolve(v),
  };
}

// ── Fixtures ─────────────────────────────────────────────────────────

const connection: PlexConnection = {
  host: "192.168.1.100",
  port: 32400,
  token: "test-token",
};

const librariesFixture: Library[] = [
  { id: "1", title: "Music", type: "artist" },
  { id: "3", title: "Podcasts", type: "artist" },
];

const artistsFixture: Artist[] = [
  {
    id: "500",
    title: "Radiohead",
    artworkUrl: "/library/metadata/500/thumb/123",
    albumsKey: "/library/metadata/500/children",
  },
  {
    id: "501",
    title: "Pink Floyd",
    artworkUrl: null,
    albumsKey: "/library/metadata/501/children",
  },
];

const albumsFixture: Album[] = [
  {
    id: "1001",
    title: "OK Computer",
    artist: "Radiohead",
    year: 1997,
    artworkUrl: "/library/metadata/1001/thumb/123",
    trackListKey: "/library/metadata/1001/children",
  },
  {
    id: "1002",
    title: "Kid A",
    artist: "Radiohead",
    year: 2000,
    artworkUrl: null,
    trackListKey: "/library/metadata/1002/children",
  },
];

const tracksFixture: Track[] = [
  {
    id: "2001",
    title: "Airbag",
    artist: "Radiohead",
    album: "OK Computer",
    duration: 282000,
    artworkUrl: "/library/metadata/1001/thumb/123",
    streamKey: "/library/parts/2001/file.flac",
  },
  {
    id: "2002",
    title: "Paranoid Android",
    artist: "Radiohead",
    album: "OK Computer",
    duration: 383000,
    artworkUrl: null,
    streamKey: "/library/parts/2002/file.flac",
  },
];

const playlistsFixture: Playlist[] = [
  { id: "5001", title: "Favorites", trackCount: 10, itemsKey: "/playlists/5001/items" },
];

const playableTrackFixture: PlayableTrack = {
  ...tracksFixture[0]!,
  streamUrl: "http://192.168.1.100:32400/library/parts/2001/file.flac?X-Plex-Token=test-token",
};

// ── Mock factories ───────────────────────────────────────────────────

function createMockPlexService(): PlexService {
  return {
    getLibraries: vi.fn<() => Promise<Library[]>>().mockResolvedValue(librariesFixture),
    getArtists: vi.fn<(k: string) => Promise<Artist[]>>().mockResolvedValue(artistsFixture),
    getAllArtists: vi.fn<() => Promise<Artist[]>>().mockResolvedValue(artistsFixture),
    getAlbums: vi.fn<(k: string) => Promise<Album[]>>().mockResolvedValue(albumsFixture),
    getAllAlbums: vi.fn<() => Promise<Album[]>>().mockResolvedValue(albumsFixture),
    getArtistAlbums: vi.fn<(k: string) => Promise<Album[]>>().mockResolvedValue(albumsFixture),
    getAlbumTracks: vi.fn<(k: string) => Promise<Track[]>>().mockResolvedValue(tracksFixture),
    getPlaylists: vi.fn<() => Promise<Playlist[]>>().mockResolvedValue(playlistsFixture),
    getPlaylistTracks: vi.fn<(k: string) => Promise<Track[]>>().mockResolvedValue(tracksFixture),
    search: vi.fn().mockResolvedValue({ tracks: tracksFixture, albums: albumsFixture }),
    getPlayableTrack: vi.fn<(id: string) => Promise<PlayableTrack>>().mockResolvedValue(playableTrackFixture),
    getStreamUrl: vi.fn<(k: string) => string>().mockImplementation(
      (streamKey: string) => `http://192.168.1.100:32400${streamKey}?X-Plex-Token=test-token`,
    ),
    getArtworkUrl: vi.fn<(p: string) => string>().mockImplementation(
      (path: string) => `http://192.168.1.100:32400${path}?X-Plex-Token=test-token`,
    ),
  } as unknown as PlexService;
}

function createMockMpdPlugin(): MpdPlugin {
  return {
    sendMpdCommand: vi.fn().mockResolvedValue(undefined),
    sendMpdCommandArray: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    seek: vi.fn().mockResolvedValue(undefined),
    clientMpd: {
      sendCommand: vi.fn(),
    },
  };
}

function createMockContext(mpdPlugin?: MpdPlugin): {
  context: VolumioContext;
  commandRouter: VolumioCoreCommand;
  logger: VolumioLogger;
} {
  const logger: VolumioLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  };

  const commandRouter: VolumioCoreCommand = {
    pushConsoleMessage: vi.fn(),
    servicePushState: vi.fn(),
    volumioAddToBrowseSources: vi.fn(),
    volumioRemoveToBrowseSources: vi.fn(),
    stateMachine: {
      setConsumeUpdateService: vi.fn(),
    },
    pluginManager: {
      getPlugin: vi.fn().mockReturnValue(mpdPlugin ?? createMockMpdPlugin()),
    },
  };

  return {
    context: { coreCommand: commandRouter, logger },
    commandRouter,
    logger,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("VolumioAdapter", () => {
  let adapter: VolumioAdapter;
  let mockService: ReturnType<typeof createMockPlexService>;
  let commandRouter: VolumioCoreCommand;
  let mpdPlugin: MpdPlugin;

  beforeEach(() => {
    mpdPlugin = createMockMpdPlugin();
    const mocks = createMockContext(mpdPlugin);
    commandRouter = mocks.commandRouter;

    adapter = new VolumioAdapter(mocks.context, createMockLibQ());
    mockService = createMockPlexService();
    adapter.configure(mockService, connection);
  });

  // ── Lifecycle ────────────────────────────────────────────────────

  describe("onStart", () => {
    it("registers browse source with Volumio", async () => {
      await adapter.onStart();

      expect(commandRouter.volumioAddToBrowseSources).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Plex",
          uri: "plex",
          plugin_type: "music_service",
          plugin_name: "plex",
        }),
      );
    });
  });

  describe("onStop", () => {
    it("removes browse source from Volumio", async () => {
      await adapter.onStop();

      expect(commandRouter.volumioRemoveToBrowseSources).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Plex", uri: "plex" }),
      );
    });

    it("clears the PlexService reference", async () => {
      await adapter.onStop();

      // Attempting to browse after stop should fail (root is static, so use artists)
      await expect(adapter.handleBrowseUri("plex/artists")).rejects.toThrow(
        "PlexService not initialized",
      );
    });
  });

  describe("getConfigurationFiles", () => {
    it("returns config.json", () => {
      expect(adapter.getConfigurationFiles()).toEqual(["config.json"]);
    });
  });

  // ── Browse: root ─────────────────────────────────────────────────

  describe("handleBrowseUri — root", () => {
    it("returns Artists, Albums, and Playlists folders at root", async () => {
      const result = (await adapter.handleBrowseUri("plex")) as NavigationPage;

      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(3);
      expect(items[0]!.title).toBe("Artists");
      expect(items[0]!.uri).toBe("plex/artists");
      expect(items[0]!.icon).toBe("fa fa-microphone");
      expect(items[1]!.title).toBe("Albums");
      expect(items[1]!.uri).toBe("plex/albums");
      expect(items[1]!.icon).toBe("fa fa-music");
      expect(items[2]!.title).toBe("Playlists");
      expect(items[2]!.uri).toBe("plex/playlists");
      expect(items[2]!.icon).toBe("fa fa-list");
    });

    it("sets prev URI to /", async () => {
      const result = (await adapter.handleBrowseUri("plex")) as NavigationPage;
      expect(result.navigation.prev.uri).toBe("/");
    });
  });

  // ── Browse: artists ─────────────────────────────────────────────

  describe("handleBrowseUri — artists", () => {
    it("returns all artists", async () => {
      const result = (await adapter.handleBrowseUri("plex/artists")) as NavigationPage;

      expect(mockService.getAllArtists).toHaveBeenCalledOnce();
      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(2);
      expect(items[0]!.title).toBe("Radiohead");
      expect(items[0]!.type).toBe("folder");
      expect(items[0]!.albumart).toContain("/library/metadata/500/thumb/123");
      expect(items[1]!.title).toBe("Pink Floyd");
      expect(items[1]!.albumart).toBeUndefined();
    });

    it("artist URIs encode the albumsKey", async () => {
      const result = (await adapter.handleBrowseUri("plex/artists")) as NavigationPage;
      const items = result.navigation.lists[0]!.items;
      expect(items[0]!.uri).toBe("plex/artist/__library__metadata__500__children");
    });
  });

  // ── Browse: artist (albums by artist) ─────────────────────────

  describe("handleBrowseUri — artist", () => {
    it("returns albums for an artist", async () => {
      const uri = "plex/artist/__library__metadata__500__children";
      const result = (await adapter.handleBrowseUri(uri)) as NavigationPage;

      expect(mockService.getArtistAlbums).toHaveBeenCalledWith(
        "/library/metadata/500/children",
      );
      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(2);
      expect(items[0]!.title).toBe("OK Computer");
      expect(items[0]!.artist).toBe("Radiohead");
      expect(items[0]!.type).toBe("folder");
    });

    it("sets prev URI to plex/artists", async () => {
      const uri = "plex/artist/__library__metadata__500__children";
      const result = (await adapter.handleBrowseUri(uri)) as NavigationPage;
      expect(result.navigation.prev.uri).toBe("plex/artists");
    });
  });

  // ── Browse: albums ────────────────────────────────────────────

  describe("handleBrowseUri — albums", () => {
    it("returns all albums", async () => {
      const result = (await adapter.handleBrowseUri("plex/albums")) as NavigationPage;

      expect(mockService.getAllAlbums).toHaveBeenCalledOnce();
      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(2);
      expect(items[0]!.title).toBe("OK Computer");
      expect(items[0]!.artist).toBe("Radiohead");
      expect(items[0]!.type).toBe("folder");
      expect(items[0]!.albumart).toContain("/library/metadata/1001/thumb/123");
      expect(items[1]!.albumart).toBeUndefined();
    });

    it("album URIs encode the trackListKey", async () => {
      const result = (await adapter.handleBrowseUri("plex/albums")) as NavigationPage;
      const items = result.navigation.lists[0]!.items;
      expect(items[0]!.uri).toBe("plex/album/__library__metadata__1001__children");
    });
  });

  // ── Browse: album ────────────────────────────────────────────────

  describe("handleBrowseUri — album", () => {
    it("returns tracks for an album", async () => {
      const uri = "plex/album/__library__metadata__1001__children";
      const result = (await adapter.handleBrowseUri(uri)) as NavigationPage;

      expect(mockService.getAlbumTracks).toHaveBeenCalledWith(
        "/library/metadata/1001/children",
      );
      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(2);
      expect(items[0]!.title).toBe("Airbag");
      expect(items[0]!.type).toBe("song");
      expect(items[0]!.uri).toBe("plex/track/2001");
      // Duration should be in seconds
      expect(items[0]!.duration).toBe(282);
    });

    it("uses album title from first track as list title", async () => {
      const uri = "plex/album/__library__metadata__1001__children";
      const result = (await adapter.handleBrowseUri(uri)) as NavigationPage;
      expect(result.navigation.lists[0]!.title).toBe("OK Computer");
    });
  });

  // ── Browse: playlists ────────────────────────────────────────────

  describe("handleBrowseUri — playlists", () => {
    it("returns playlist list", async () => {
      const result = (await adapter.handleBrowseUri("plex/playlists")) as NavigationPage;

      expect(mockService.getPlaylists).toHaveBeenCalledOnce();
      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(1);
      expect(items[0]!.title).toBe("Favorites");
      expect(items[0]!.type).toBe("folder");
      expect(items[0]!.uri).toBe("plex/playlist/__playlists__5001__items");
    });
  });

  // ── Browse: playlist tracks ──────────────────────────────────────

  describe("handleBrowseUri — playlist tracks", () => {
    it("returns tracks in a playlist", async () => {
      const uri = "plex/playlist/__playlists__5001__items";
      const result = (await adapter.handleBrowseUri(uri)) as NavigationPage;

      expect(mockService.getPlaylistTracks).toHaveBeenCalledWith("/playlists/5001/items");
      const items = result.navigation.lists[0]!.items;
      expect(items).toHaveLength(2);
      expect(items[0]!.title).toBe("Airbag");
      expect(items[0]!.type).toBe("song");
    });

    it("sets prev URI to plex/playlists", async () => {
      const uri = "plex/playlist/__playlists__5001__items";
      const result = (await adapter.handleBrowseUri(uri)) as NavigationPage;
      expect(result.navigation.prev.uri).toBe("plex/playlists");
    });
  });

  // ── Browse: error handling ───────────────────────────────────────

  describe("handleBrowseUri — errors", () => {
    it("rejects unknown URIs", async () => {
      await expect(adapter.handleBrowseUri("plex/unknown/thing")).rejects.toThrow(
        "Unknown browse URI",
      );
    });

    it("propagates PlexService errors", async () => {
      vi.mocked(mockService.getAllArtists).mockRejectedValue(new Error("Network failure"));
      await expect(adapter.handleBrowseUri("plex/artists")).rejects.toThrow("Network failure");
    });
  });

  // ── Explode: single track ────────────────────────────────────────

  describe("explodeUri — track", () => {
    it("resolves a single track to a QueueItem", async () => {
      const result = (await adapter.explodeUri("plex/track/2001")) as QueueItem[];

      expect(mockService.getPlayableTrack).toHaveBeenCalledWith("2001");
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("Airbag");
      expect(result[0]!.artist).toBe("Radiohead");
      expect(result[0]!.album).toBe("OK Computer");
      expect(result[0]!.uri).toContain("/library/parts/2001/file.flac");
      expect(result[0]!.service).toBe("plex");
      expect(result[0]!.type).toBe("track");
      expect(result[0]!.duration).toBe(282);
    });
  });

  // ── Explode: album ───────────────────────────────────────────────

  describe("explodeUri — album", () => {
    it("resolves all album tracks to QueueItems", async () => {
      const uri = "plex/album/__library__metadata__1001__children";
      const result = (await adapter.explodeUri(uri)) as QueueItem[];

      expect(mockService.getAlbumTracks).toHaveBeenCalledWith(
        "/library/metadata/1001/children",
      );
      expect(mockService.getPlayableTrack).not.toHaveBeenCalled();
      expect(result).toHaveLength(2);
      expect(result[0]!.name).toBe("Airbag");
      expect(result[0]!.uri).toContain("/library/parts/2001/file.flac");
      expect(result[1]!.name).toBe("Paranoid Android");
      expect(result[1]!.uri).toContain("/library/parts/2002/file.flac");
    });
  });

  // ── Explode: errors ──────────────────────────────────────────────

  describe("explodeUri — errors", () => {
    it("rejects unknown URIs", async () => {
      await expect(adapter.explodeUri("plex/unknown/123")).rejects.toThrow("Cannot explode URI");
    });
  });

  // ── clearAddPlayTrack ────────────────────────────────────────────

  describe("clearAddPlayTrack", () => {
    const queueItem: QueueItem = {
      uri: "http://192.168.1.100:32400/library/parts/2001/file.flac?X-Plex-Token=test-token",
      service: "plex",
      name: "Airbag",
      artist: "Radiohead",
      album: "OK Computer",
      albumart: "",
      duration: 282,
      type: "track",
    };

    it("sends stop, clear, then tries load before falling back to addid", async () => {
      // load fails, so addid is used as fallback
      vi.mocked(mpdPlugin.sendMpdCommand).mockImplementation((cmd: string) => {
        if (cmd.startsWith("load ")) return Promise.reject(new Error("not supported"));
        if (cmd.startsWith("addid ")) return Promise.resolve({ Id: "42" });
        return Promise.resolve(undefined);
      });

      await adapter.clearAddPlayTrack(queueItem);

      const mpdSend = vi.mocked(mpdPlugin.sendMpdCommand);
      expect(mpdSend).toHaveBeenCalledWith("stop", []);
      expect(mpdSend).toHaveBeenCalledWith("clear", []);
      expect(mpdSend).toHaveBeenCalledWith(`load "${queueItem.uri}"`, []);
      expect(mpdSend).toHaveBeenCalledWith(`addid "${queueItem.uri}"`, []);
      expect(mpdSend).toHaveBeenCalledWith("play", []);
    });

    it("skips addid when load succeeds", async () => {
      await adapter.clearAddPlayTrack(queueItem);

      const mpdSend = vi.mocked(mpdPlugin.sendMpdCommand);
      expect(mpdSend).toHaveBeenCalledWith(`load "${queueItem.uri}"`, []);
      expect(mpdSend).not.toHaveBeenCalledWith(`addid "${queueItem.uri}"`, []);
    });

    it("sets metadata tags via addtagid when addid returns a song ID", async () => {
      vi.mocked(mpdPlugin.sendMpdCommand).mockImplementation((cmd: string) => {
        if (cmd.startsWith("load ")) return Promise.reject(new Error("not supported"));
        if (cmd.startsWith("addid ")) return Promise.resolve({ Id: "42" });
        return Promise.resolve(undefined);
      });

      await adapter.clearAddPlayTrack(queueItem);

      expect(vi.mocked(mpdPlugin.sendMpdCommandArray)).toHaveBeenCalledWith([
        { command: "addtagid", parameters: ["42", "title", "Airbag"] },
        { command: "addtagid", parameters: ["42", "album", "OK Computer"] },
        { command: "addtagid", parameters: ["42", "artist", "Radiohead"] },
      ]);
    });

    it("does not set tags when load succeeds (no song ID)", async () => {
      await adapter.clearAddPlayTrack(queueItem);

      expect(vi.mocked(mpdPlugin.sendMpdCommandArray)).not.toHaveBeenCalled();
    });

    it("sets consume update service before playing", async () => {
      await adapter.clearAddPlayTrack(queueItem);

      expect(commandRouter.stateMachine.setConsumeUpdateService).toHaveBeenCalledWith(
        "mpd",
        true,
        false,
      );
    });
  });

  // ── Playback controls ────────────────────────────────────────────

  describe("playback controls", () => {
    it("stop sets consume update service and delegates to mpd plugin", async () => {
      await adapter.stop();
      expect(commandRouter.stateMachine.setConsumeUpdateService).toHaveBeenCalledWith("mpd", true, false);
      expect(vi.mocked(mpdPlugin.stop)).toHaveBeenCalled();
    });

    it("pause sets consume update service and delegates to mpd plugin", async () => {
      await adapter.pause();
      expect(commandRouter.stateMachine.setConsumeUpdateService).toHaveBeenCalledWith("mpd", true, false);
      expect(vi.mocked(mpdPlugin.pause)).toHaveBeenCalled();
    });

    it("resume sets consume update service and delegates to mpd plugin", async () => {
      await adapter.resume();
      expect(commandRouter.stateMachine.setConsumeUpdateService).toHaveBeenCalledWith("mpd", true, false);
      expect(vi.mocked(mpdPlugin.resume)).toHaveBeenCalled();
    });

    it("seek sets consume update service and delegates to mpd plugin", async () => {
      await adapter.seek(45000);
      expect(commandRouter.stateMachine.setConsumeUpdateService).toHaveBeenCalledWith("mpd", true, false);
      expect(vi.mocked(mpdPlugin.seek)).toHaveBeenCalledWith(45000);
    });
  });

  // ── Search ───────────────────────────────────────────────────────

  describe("search", () => {
    it("returns tracks and albums in Volumio format", async () => {
      const result = (await adapter.search({ value: "radiohead" })) as SearchResultSection[];

      expect(mockService.search).toHaveBeenCalledWith("radiohead");
      expect(result).toHaveLength(2);

      // Tracks section
      expect(result[0]!.title).toBe("Plex Tracks");
      expect(result[0]!.items).toHaveLength(2);
      expect(result[0]!.items[0]!.title).toBe("Airbag");
      expect(result[0]!.items[0]!.type).toBe("song");

      // Albums section
      expect(result[1]!.title).toBe("Plex Albums");
      expect(result[1]!.items).toHaveLength(2);
      expect(result[1]!.items[0]!.title).toBe("OK Computer");
      expect(result[1]!.items[0]!.type).toBe("folder");
    });

    it("omits empty sections", async () => {
      vi.mocked(mockService.search).mockResolvedValue({ tracks: [], albums: [] });

      const result = (await adapter.search({ value: "nothing" })) as SearchResultSection[];
      expect(result).toHaveLength(0);
    });

    it("returns only tracks section when no album matches", async () => {
      vi.mocked(mockService.search).mockResolvedValue({
        tracks: tracksFixture,
        albums: [],
      });

      const result = (await adapter.search({ value: "airbag" })) as SearchResultSection[];
      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe("Plex Tracks");
    });
  });

  // ── pushState ────────────────────────────────────────────────────

  describe("pushState", () => {
    it("delegates to commandRouter.servicePushState", () => {
      const state = {
        status: "play" as const,
        service: "plex",
        title: "Test",
        artist: "Artist",
        album: "Album",
        albumart: "",
        uri: "http://example.com/track",
        seek: 0,
        duration: 300,
      };

      adapter.pushState(state);

      expect(commandRouter.servicePushState).toHaveBeenCalledWith(state, "plex");
    });
  });
});
