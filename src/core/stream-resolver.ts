/**
 * Stream URL Resolver — pure functions that build complete, playable
 * streaming URLs from Plex server connection details and track keys.
 *
 * Supports both direct play (original file) and transcoded streams.
 * No network calls or side effects.
 */

/** Connection details needed to build any Plex URL. */
export interface PlexConnection {
  host: string;
  port: number;
  token: string;
}

/** Options for building a stream URL. */
export interface StreamOptions extends PlexConnection {
  /** The Part key from a parsed Track (e.g. "/library/parts/2001/1234567/file.flac") */
  trackKey: string;
  /** When true, request a transcoded stream instead of the original file. Default: false */
  transcode?: boolean;
  /** Target format for transcoding. Only used when transcode is true. Default: "mp3" */
  format?: "mp3" | "flac" | "aac";
}

/**
 * Build a complete streaming URL for a Plex track.
 *
 * Direct play returns the original file via the Part key.
 * Transcoded play routes through Plex's universal transcoder.
 */
export function buildStreamUrl(options: StreamOptions): string {
  const { host, port, token, trackKey, transcode = false, format = "mp3" } = options;
  const base = `http://${host}:${port}`;

  if (transcode) {
    return buildTranscodeUrl(base, token, trackKey, format);
  }

  return buildDirectUrl(base, token, trackKey);
}

/**
 * Build a full URL for a relative Plex resource path (e.g. artwork thumbnails).
 * Appends the authentication token as a query parameter.
 */
export function buildResourceUrl(connection: PlexConnection, path: string): string {
  const { host, port, token } = connection;
  return `http://${host}:${port}${path}?X-Plex-Token=${encodeURIComponent(token)}`;
}

function buildDirectUrl(base: string, token: string, trackKey: string): string {
  return `${base}${trackKey}?X-Plex-Token=${encodeURIComponent(token)}`;
}

function buildTranscodeUrl(
  base: string,
  token: string,
  trackKey: string,
  format: string,
): string {
  const params = new URLSearchParams({
    path: trackKey,
    mediaIndex: "0",
    partIndex: "0",
    protocol: "http",
    "X-Plex-Token": token,
  });

  // Set the appropriate container/codec for each format
  const codecMap: Record<string, { container: string; audioCodec: string }> = {
    mp3: { container: "mp3", audioCodec: "mp3" },
    flac: { container: "flac", audioCodec: "flac" },
    aac: { container: "mp4", audioCodec: "aac" },
  };
  const codec = codecMap[format] ?? codecMap["mp3"]!;
  params.set("container", codec.container);
  params.set("audioCodec", codec.audioCodec);

  return `${base}/music/:/transcode/universal/start?${params.toString()}`;
}
