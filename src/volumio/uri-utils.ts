// ── URI encoding helpers ─────────────────────────────────────────────
// Plex keys contain slashes (e.g. "/library/metadata/1001/children").
// We encode them for safe embedding in our URI scheme by replacing / with __.

export function encodePathSegment(key: string): string {
  return key.replace(/\//g, "__");
}

export function decodePathSegment(encoded: string): string {
  return encoded.replace(/__/g, "/");
}

/** Fisher-Yates in-place shuffle. */
export function shuffleArray<T>(array: T[]): void {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j]!, array[i]!];
  }
}

export interface PaginationState {
  libraryKey: string | null;
  offset: number;
}

export function parsePaginationUri(uri: string): PaginationState {
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
