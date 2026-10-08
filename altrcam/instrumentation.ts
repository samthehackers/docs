export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { envIssues } = await import("./lib/env");
    const missing = envIssues();
    // Public pages must keep working without every credential, so this is loud but not fatal.
    // Features that need a missing one answer with a clear "unavailable" error; see /api/health.
    if (missing.length) {
      console.error(`[altrcam] Missing or invalid environment variables: ${missing.join(", ")}. Affected features are unavailable until they are set.`);
    }
  }
}
