export type ArgumentType = "string" | "integer" | "boolean";

export type PropertySchema = { type: ArgumentType; description: string; default?: number | boolean };

export type InputSchema = {
  type: "object";
  properties: Record<string, PropertySchema>;
  required: string[];
};

export type ToolSchema = { name: string; inputSchema: InputSchema };

export type ArgumentCheck = { ok: true; args: Record<string, unknown> } | { ok: false; text: string };

function quoted(names: string[]): string {
  return names.map((name) => `'${name}'`).join(", ");
}

function hasType(value: unknown, type: ArgumentType): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === type;
}

/** Validate `args` against the tool's schema, remapping a single misnamed argument. */
export function checkArguments(tools: readonly ToolSchema[], name: string, args: Record<string, unknown>): ArgumentCheck {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, text: `Unknown tool: ${name}. Tools: ${tools.map((t) => t.name).join(", ")}` };
  }
  const { properties, required } = tool.inputSchema;
  const accepted = Object.keys(properties);
  const provided = Object.keys(args);
  const missing = required.filter((key) => !provided.includes(key)).sort();
  const unknown = provided.filter((key) => !accepted.includes(key)).sort();

  let result = args;
  if (missing.length === 1 && unknown.length === 1) {
    result = { ...args, [missing[0]!]: args[unknown[0]!] };
    delete result[unknown[0]!];
  } else if (missing.length > 0) {
    let text = `${name}: missing required argument ${quoted(missing)}.`;
    if (unknown.length > 0) {
      text += ` Not accepted: ${quoted(unknown)}; the value probably belongs in ${quoted(missing)}.`;
    }
    const list = accepted.map((key) => (required.includes(key) ? `${key} (required)` : key)).join(", ");
    return { ok: false, text: `${text} Accepted arguments: ${list}.` };
  }

  for (const key of accepted) {
    const value = result[key];
    if (value !== undefined && !hasType(value, properties[key]!.type)) {
      return { ok: false, text: `${name}: argument '${key}' must be ${properties[key]!.type}.` };
    }
  }
  return { ok: true, args: result };
}
