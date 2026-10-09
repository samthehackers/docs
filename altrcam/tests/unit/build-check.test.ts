/**
 * The build-time guard for the sign-up switch (lib/build-check.ts), and that next.config.ts really runs it during `next build`
 * and only then. The deliberate rule: a Production build with SIGNUPS_OPEN=true and a missing credential fails; SIGNUPS_OPEN
 * unset or "false" never fails a build, because production has no credentials yet and every deploy would be blocked.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { SIGNUP_REQUIRED_ENV, signupBuildError } from "@/lib/build-check";
import nextConfig from "@/next.config";

const ALL = { NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_secretvalue", CLERK_SECRET_KEY: "sk_live_secretvalue", DATABASE_URL: "postgres://u:secretvalue@h/db" };
const prod = (o: Record<string, string | undefined> = {}) => ({ VERCEL_ENV: "production", ...o });
/** The variable names the message says are missing. */
const missingIn = (err: string | null) => err?.match(/is missing ([A-Z_, ]+)\./)?.[1].split(", ") ?? [];

describe("signupBuildError", () => {
  it("passes a Production build with sign-up on and every credential set", () => {
    expect(signupBuildError(prod({ SIGNUPS_OPEN: "true", ...ALL }))).toBeNull();
  });

  it.each(SIGNUP_REQUIRED_ENV)("fails a Production build with sign-up on and %s missing, naming it and only it", (name) => {
    const env = prod({ SIGNUPS_OPEN: "true", ...ALL, [name]: undefined });
    const err = signupBuildError(env);
    expect(missingIn(err)).toEqual([name]);
    expect(err).toContain("SIGNUPS_OPEN=false"); // says how to get the deploy through without opening sign-up
  });

  it("names every missing variable when several are missing, and treats an empty value as missing", () => {
    const err = signupBuildError(prod({ SIGNUPS_OPEN: "true", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "", CLERK_SECRET_KEY: undefined, DATABASE_URL: "postgres://x" }));
    expect(missingIn(err)).toEqual(["NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"]);
  });

  it("never prints a value", () => {
    const err = signupBuildError(prod({ SIGNUPS_OPEN: "true", ...ALL, DATABASE_URL: undefined }))!;
    expect(err).not.toMatch(/secretvalue/);
  });

  it("does NOT fail a Production build when SIGNUPS_OPEN is unset, empty or \"false\", even with no credentials at all (the deliberate decision)", () => {
    for (const flag of [undefined, "", "false"]) expect(signupBuildError(prod({ SIGNUPS_OPEN: flag }))).toBeNull();
  });

  it("never fails a Preview, development or local build", () => {
    for (const VERCEL_ENV of ["preview", "development", undefined]) expect(signupBuildError({ VERCEL_ENV, SIGNUPS_OPEN: "true" })).toBeNull();
  });

  it("fails a Production build whose SIGNUPS_OPEN is neither \"true\" nor \"false\", so a typo can't silently keep sign-up shut", () => {
    for (const flag of ["TRUE", "yes", "1", " true"]) expect(signupBuildError(prod({ SIGNUPS_OPEN: flag, ...ALL }))).toMatch(/must be exactly "true" or "false"/);
  });
});

describe("next.config.ts", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  const setEnv = (o: Record<string, string | undefined>) => { for (const [k, v] of Object.entries(o)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };

  it("throws while building for Vercel Production with sign-up on and a credential missing", () => {
    setEnv({ VERCEL_ENV: "production", SIGNUPS_OPEN: "true", ...ALL, CLERK_SECRET_KEY: undefined });
    expect(() => nextConfig(PHASE_PRODUCTION_BUILD)).toThrow(/CLERK_SECRET_KEY/);
  });
  it("builds when sign-up is off, and the result is the real config", () => {
    setEnv({ VERCEL_ENV: "production", SIGNUPS_OPEN: undefined, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined, CLERK_SECRET_KEY: undefined, DATABASE_URL: undefined });
    const c = nextConfig(PHASE_PRODUCTION_BUILD);
    expect(c.poweredByHeader).toBe(false);
    expect(typeof c.headers).toBe("function");
  });
  it("only checks during the build: dev and `next start` load the config without the check", () => {
    setEnv({ VERCEL_ENV: "production", SIGNUPS_OPEN: "true", NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: undefined, CLERK_SECRET_KEY: undefined, DATABASE_URL: undefined });
    expect(() => nextConfig(PHASE_DEVELOPMENT_SERVER)).not.toThrow();
    expect(() => nextConfig(PHASE_PRODUCTION_SERVER)).not.toThrow();
  });
});
