// The state of a form that is saved as a whole: the values as typed, which
// fields were edited, and whether a save was attempted. A field's problem
// shows once it is edited, or for every field after a save attempt.
import { useState } from "react";
import type { FormProblems } from "./projects.ts";

/** A form over `initial`, checked by `check` on every render. */
export function useForm<T extends object>(initial: () => T, check: (values: T) => FormProblems) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);

  const problems = check(values);
  const count = Object.keys(problems).length;

  // `env.2.name` belongs to the field `env`.
  const shown = attempted ? problems : Object.fromEntries(Object.entries(problems).filter(([k]) => touched.has(k.split(".")[0])));

  /** Changes one field and marks it edited. */
  const set = <K extends keyof T>(key: K, value: T[K]) => {
    setValues((v) => ({ ...v, [key]: value }));
    setTouched((t) => new Set(t).add(String(key)));
  };

  /** Whether the form may be saved; when not, every problem is shown from now on. */
  const attempt = (): boolean => {
    setAttempted(true);
    return count === 0;
  };

  return { values, set, problems, count, shown, attempted, attempt };
}
