// The shared JSON Schema (src/tryout.schema.json, a copy of
// schema/tryout.schema.json that the agent also embeds) and its compiled
// validators.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";

export const schema = JSON.parse(readFileSync(new URL("./tryout.schema.json", import.meta.url), "utf8"));

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema, "tryout");

/** tryout.yaml: bootstrap and, optionally, settings. */
export const validateFile = ajv.getSchema("tryout")!;

/** A stored revision: the settings alone. */
export const validateSettingsDocument = ajv.getSchema("tryout#/$defs/settings_document")!;

/** The agent's POST /v1/sessions contract; the agent validates with the same schema. */
export const validateSessionRequest = ajv.getSchema("tryout#/$defs/session_request")!;
