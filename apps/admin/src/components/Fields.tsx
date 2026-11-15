// Inputs that edit the draft: each keeps what is typed, writes it to the
// draft only once it parses, and says why when it does not. A change from
// outside (Discard, a newer revision) replaces what is typed.
import { Field, Input, InputGroup, Text } from "@chakra-ui/react";
import { useState } from "react";
import { deepEqual } from "../settings/document.ts";

interface DraftFieldProps<T> {
  label: string;
  /** The value in the draft. */
  value: T;
  format: (value: T) => string;
  /** The value of a text, or undefined when it is not valid. */
  parse: (text: string) => T | undefined;
  onCommit: (value: T) => void;
  /** Shown when the text does not parse. */
  invalid: string;
  help?: string;
  /** A unit inside the input, on the right. */
  unit?: string;
  mono?: boolean;
  placeholder?: string;
  /** A problem with the value itself, such as a missing alt text. */
  problem?: string;
}

/** A labelled text input over a draft value. */
export function DraftField<T>(props: DraftFieldProps<T>) {
  const { label, value, format, parse, onCommit, invalid, help, unit, mono, placeholder, problem } = props;
  const [text, setText] = useState(() => format(value));
  const [shown, setShown] = useState(value);

  // The draft changed from elsewhere: show its value.
  if (!deepEqual(value, shown)) {
    setShown(value);
    setText(format(value));
  }

  /** Keeps the text, and writes its value to the draft when it parses. */
  const change = (next: string) => {
    setText(next);

    const parsed = parse(next);
    if (parsed === undefined || deepEqual(parsed, value)) return;
    setShown(parsed);
    onCommit(parsed);
  };

  const error = parse(text) === undefined ? invalid : problem;
  const input = (
    <Input
      value={text}
      onChange={(e) => change(e.target.value)}
      placeholder={placeholder}
      fontFamily={mono ? "mono" : undefined}
      h="10"
      borderColor="border.emphasized"
      autoComplete="off"
      spellCheck={false}
    />
  );

  return (
    <Field.Root invalid={error !== undefined}>
      <Field.Label textStyle="label-sm">{label}</Field.Label>
      {unit ? (
        <InputGroup endElement={<Text textStyle="text-xs" color="fg.subtle">{unit}</Text>}>{input}</InputGroup>
      ) : (
        input
      )}
      {error ? (
        <Field.ErrorText textStyle="text-xs">{error}</Field.ErrorText>
      ) : (
        help && (
          <Field.HelperText textStyle="text-xs" color="fg.subtle">
            {help}
          </Field.HelperText>
        )
      )}
    </Field.Root>
  );
}

/** A whole number, 0 or more, or undefined. */
export const parseWhole = (text: string) => (/^\d{1,9}$/.test(text.trim()) ? Number(text.trim()) : undefined);

/** A duration such as 90s, 15m or 1h30m, or undefined. */
export const parseDuration = (text: string) => {
  const t = text.trim();
  return t.length >= 2 && /^(\d+h)?(\d+m)?(\d+s)?$/.test(t) ? t : undefined;
};
