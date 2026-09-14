/** Reject obsolete configuration before opening listeners or persistent stores. */
export function assertCurrentEnvironment(env: Record<string, string | undefined>): void {
  const legacy = Object.keys(env)
    .filter((key) => key.startsWith("WASMPLANE_") && env[key] !== undefined)
    .sort();
  if (legacy.length) {
    // Report names only: configuration values may contain tokens or encryption keys.
    throw new Error(
      `Obsolete environment settings: ${legacy.join(", ")}. ` +
        "Rename them to ODENCTL_* or ODEN_* as described in docs/user/rebranding.md before starting.",
    );
  }
}
