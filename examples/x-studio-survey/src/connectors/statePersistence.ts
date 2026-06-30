/**
 * Client helpers for persisting the dashboard session (present state + undo/redo history)
 * to the survey dev server's `/api/state` endpoints.
 *
 * Persistence is enabled only when `STUDIO_SERVER_URL` is configured — without a backend
 * the app runs entirely in-memory, exactly as before.
 */
const serverUrl = (import.meta.env.STUDIO_SERVER_URL as string | undefined)?.replace(/\/$/, '');
const token = import.meta.env.STUDIO_SERVER_TOKEN as string | undefined;

/** Whether a backend is configured to persist state to. */
export const statePersistenceEnabled = Boolean(serverUrl);

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) {
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

/** Loads the saved session, or `null` when none has been stored (or persistence is off). */
export async function loadSession(signal?: AbortSignal): Promise<unknown | null> {
  if (!serverUrl) {
    return null;
  }
  const res = await fetch(`${serverUrl}/api/state`, { headers: headers(), signal });
  if (!res.ok) {
    throw new Error(`Failed to load dashboard state (HTTP ${res.status})`);
  }
  const data = (await res.json()) as { session?: unknown };
  return data.session ?? null;
}

/**
 * Persists the session.
 * @param keepalive - When `true`, uses a keepalive fetch so the request survives a page
 *   unload (used for the final flush on `pagehide`).
 */
export async function saveSession(session: unknown, keepalive = false): Promise<void> {
  if (!serverUrl) {
    return;
  }
  const res = await fetch(`${serverUrl}/api/state`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ session }),
    keepalive,
  });
  if (!res.ok) {
    throw new Error(`Failed to save dashboard state (HTTP ${res.status})`);
  }
}
