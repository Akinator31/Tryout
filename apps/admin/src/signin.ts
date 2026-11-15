// What the sign-in page says when a sign-in fails, from the API's answer.
import { ApiError } from "./api.ts";
import { strings } from "./strings.ts";

export interface Problem {
  title: string;
  detail: string;
}

/**
 * The message for a failed sign-in: wrong credentials (401, also for an
 * unknown account), too many attempts (429, with Retry-After), the HTTPS rule
 * (400 from the server, normally caught before sending), a busy server (503),
 * or anything else.
 */
export function signInProblem(e: unknown): Problem {
  if (!(e instanceof ApiError)) return strings.signIn.failed;

  switch (e.status) {
    case 401:
      return strings.signIn.wrong;
    case 429:
      return strings.signIn.limited(e.retryAfterS);
    case 400:
      return e.message.includes("HTTPS") ? strings.signIn.insecure : strings.signIn.failed;
    case 503:
      return strings.signIn.busy;
    default:
      return strings.signIn.failed;
  }
}
