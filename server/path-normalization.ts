const WINDOWS_ABSOLUTE_PATH_RE = /^[A-Za-z]:[\\/]/;
const EMBEDDED_WINDOWS_PATH_RE = /([A-Za-z]:[\\/].*)$/;

function toWslPathFromWindowsPath(windowsPath: string): string {
  const slashNormalized = windowsPath.replace(/\\/g, "/");
  const driveLetter = slashNormalized[0]?.toLowerCase();
  const rest = slashNormalized.slice(2).replace(/^\/+/, "");
  return `/mnt/${driveLetter}/${rest}`;
}

/**
 * Normalize repository path input across Windows/WSL boundaries.
 *
 * - On POSIX (WSL/Linux), converts `C:\foo\bar` to `/mnt/c/foo/bar`.
 * - If a mixed path accidentally contains a trailing Windows path segment,
 *   prefers that trailing Windows path and normalizes it.
 */
export function normalizeRepoPathInput(input?: string): string | undefined {
  if (!input) {
    return undefined;
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }

  const embeddedWindowsMatch = trimmed.match(EMBEDDED_WINDOWS_PATH_RE);
  const candidate = embeddedWindowsMatch?.[1] ?? trimmed;

  if (process.platform !== "win32" && WINDOWS_ABSOLUTE_PATH_RE.test(candidate)) {
    return toWslPathFromWindowsPath(candidate);
  }

  return candidate;
}
