/**
 * Undo Bun's dropped drive-root separator.
 *
 * On Windows, Bun's `realpath("L:\\")` returns `"L:"`. A bare drive letter is not
 * the drive's root to Windows but "the current directory on that drive", so
 * `resolve("L:")` became the daemon's working directory: browsing a drive listed
 * the daemon's own folder, and a drive given as a root (`PEW2_BROWSE_ROOTS=L:\`,
 * `PEW2_IMAGE_ROOTS`) allowed that folder instead. Node returns `"L:\\"`; this
 * restores that for whatever `realpath` produced, and changes nothing else.
 */
export function keepDriveRoot(realPath: string): string {
  return /^[A-Za-z]:$/.test(realPath) ? `${realPath}\\` : realPath;
}
