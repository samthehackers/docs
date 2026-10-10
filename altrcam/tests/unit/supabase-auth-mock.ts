/**
 * The one auth seam the server uses: `createClient()` from lib/supabase/server and its `auth.getUser()`, which in
 * production asks the Supabase Auth server who the session cookie belongs to. Tests replace that module with this fake
 * and pick the user per test:
 *
 *   const h = vi.hoisted(() => ({ me: null as string | null, admins: new Set<string>() }));
 *   vi.mock("@/lib/supabase/server", async () => (await import("./supabase-auth-mock")).fakeServerModule(h));
 *
 * `admins` get `app_metadata.role = "admin"` (only the secret key can set it in real Supabase); ids in `unconfirmed`
 * have no `email_confirmed_at`; `authThrows` makes getUser throw (Auth unreachable).
 */
export interface FakeAuthState {
  me: string | null;
  admins?: Set<string>;
  unconfirmed?: Set<string>;
  authThrows?: boolean | Error;
  authCalls?: number;
}

export function fakeUser(id: string, state: FakeAuthState) {
  return {
    id,
    email: `${id}@example.com`,
    email_confirmed_at: state.unconfirmed?.has(id) ? null : "2026-01-01T00:00:00Z",
    app_metadata: state.admins?.has(id) ? { role: "admin", provider: "email" } : { provider: "email" },
    user_metadata: { full_name: id },
  };
}

export function fakeServerModule(state: FakeAuthState) {
  return {
    createClient: async () => ({
      auth: {
        getUser: async () => {
          state.authCalls = (state.authCalls ?? 0) + 1;
          if (state.authThrows) throw state.authThrows instanceof Error ? state.authThrows : new Error("auth down");
          return { data: { user: state.me ? fakeUser(state.me, state) : null }, error: null };
        },
      },
    }),
  };
}
