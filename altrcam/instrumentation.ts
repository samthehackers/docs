export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.NODE_ENV === "production") {
    const { env } = await import("./lib/env");
    env(); // fail the boot, not the first request
  }
}
