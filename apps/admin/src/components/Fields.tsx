// Inputs of the settings pages: DraftField edits the draft as it is typed,
// keeping the text and writing it only once it parses; a change from outside
// (Discard, a newer revision) replaces the text. FormField belongs to a form
// that keeps its own state until it is saved.
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

interface FormFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** Why the value is refused; replaces the help while set. */
  error?: string;
  help?: string;
  unit?: string;
  mono?: boolean;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
}

/** A labelled text input of a form that keeps its own state until it is saved. */
export function FormField(props: FormFieldProps) {
  const { label, value, onChange, error, help, unit, mono, placeholder, required, disabled } = props;
  const input = (
    <Input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      fontFamily={mono ? "mono" : undefined}
      h="10"
      borderColor="border.emphasized"
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
    />
  );

  return (
    <Field.Root invalid={error !== undefined} required={required}>
      <Field.Label textStyle="label-sm">
        {label}
        {required && <Field.RequiredIndicator />}
      </Field.Label>
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
