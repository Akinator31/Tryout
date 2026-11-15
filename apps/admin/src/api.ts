// The admin API client: JSON in and out, errors as ApiError, and the
// control plane's reachability as seen by the last call, which the sidebar
// shows. The session cookie travels on its own (same origin, HttpOnly).

/** An answer other than 2xx, or no answer at all (status 0). */
export class ApiError extends Error {
  readonly status: number;
  /** Seconds from Retry-After, when the answer had one. */
  readonly retryAfterS: number | null;
  /** The JSON body's extra fields, beside `error`. */
  readonly details: Record<string, unknown>;

  constructor(status: number, message: string, retryAfterS: number | null = null, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.retryAfterS = retryAfterS;
    this.details = details;
  }
}

export interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
}

export interface ApiClient {
  /** Calls `/admin/api/<path>`; resolves to the JSON body, or undefined for an empty one. */
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  /** Whether the control plane answered the last call. */
  reachable(): boolean;
  /** Calls `listener` whenever reachable() changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** Seconds in a Retry-After header, or null when absent or a date. */
function retryAfter(res: Response): number | null {
  const value = Number(res.headers.get("retry-after"));
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** The answer's JSON body, or an empty object when it has none or it is not JSON. */
async function readJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Turns a non-2xx answer into an ApiError, with the server's message when it sent one. */
async function toError(res: Response): Promise<ApiError> {
  const { error, ...details } = await readJson(res);
  const message = typeof error === "string" ? error : `HTTP ${res.status}`;
  return new ApiError(res.status, message, retryAfter(res), details);
}

/**
 * A client over `fetchFn`. A 5xx other than 503 (busy) or no answer marks the
 * control plane unreachable; any other answer marks it reachable.
 */
export function createApiClient(fetchFn: typeof fetch = (...args) => fetch(...args)): ApiClient {
  let up = true;
  const listeners = new Set<() => void>();

  /** Records whether the control plane answered, telling listeners on change. */
  function mark(next: boolean): void {
    if (next === up) return;
    up = next;
    for (const listener of listeners) listener();
  }

  async function send(path: string, { method = "GET", body }: RequestOptions): Promise<Response> {
    const hasBody = body !== undefined || method !== "GET";
    try {
      return await fetchFn(`/admin/api/${path}`, {
        method,
        headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}) },
        body: hasBody ? JSON.stringify(body ?? {}) : undefined,
        credentials: "same-origin",
      });
    } catch {
      mark(false);
      throw new ApiError(0, "no answer");
    }
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const res = await send(path, options);
    mark(res.status < 500 || res.status === 503);

    if (!res.ok) throw await toError(res);
    if (res.status === 204) return undefined as T;
    return (await readJson(res)) as T;
  }

  return {
    request,
    reachable: () => up,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Whether an error means the session is gone and the browser must sign in again. */
export const isSignedOut = (e: unknown) => e instanceof ApiError && e.status === 401;
