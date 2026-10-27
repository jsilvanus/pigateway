// pigateway CLI, generated at run time from openapi/openapi.json: one command per operationId.
// No dependencies. Usage: pigateway <command> [--param value ...] [--json '{...}'] [--file path]
import { readFile } from "node:fs/promises";

export function kebab(operationId) {
  return operationId.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function operations(spec) {
  const list = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op.operationId) continue;
      list.push({ command: kebab(op.operationId), method: method.toUpperCase(), path, op, parameters: [...(item.parameters ?? []), ...(op.parameters ?? [])] });
    }
  }
  return list.sort((a, b) => a.command.localeCompare(b.command));
}

function deref(spec, schema) {
  let s = schema;
  while (s?.$ref) s = s.$ref.replace("#/", "").split("/").reduce((o, k) => o?.[k], spec);
  return s ?? {};
}

function coerce(value, schema) {
  if (value === true) value = "true";
  switch (schema.type) {
    case "integer":
    case "number": {
      const n = Number(value);
      if (!Number.isFinite(n) || (schema.type === "integer" && !Number.isInteger(n))) throw new Error(`"${value}" is not a ${schema.type}`);
      return n;
    }
    case "boolean":
      if (value !== "true" && value !== "false") throw new Error(`"${value}" is not true or false`);
      return value === "true";
    default:
      return String(value);
  }
}

/** Parses `--name value` pairs; a bare `--flag` is "true". */
export function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument "${arg}"`);
    const eq = arg.indexOf("=");
    if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) flags[arg.slice(2)] = argv[++i];
    else flags[arg.slice(2)] = "true";
  }
  return flags;
}

/** Turns an operation and flags into { method, url, headers, body }. Pure apart from `readBinary`. */
export async function buildRequest(spec, entry, flags, { baseUrl, apiKey, readBinary = (p) => readFile(p) } = {}) {
  const base = (baseUrl ?? spec.servers?.[0]?.url ?? "").replace(/\/$/, "");
  const left = { ...flags };
  let path = entry.path;
  const query = new URLSearchParams();
  for (const param of entry.parameters) {
    const p = param.$ref ? deref(spec, param) : param;
    const raw = left[p.name];
    delete left[p.name];
    if (raw === undefined) {
      if (p.required) throw new Error(`Missing --${p.name}`);
      continue;
    }
    const value = coerce(raw, deref(spec, p.schema));
    if (p.in === "path") path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
    else if (p.in === "query") query.set(p.name, String(value));
  }
  const headers = apiKey ? { "x-api-key": apiKey } : {};
  let body;
  const content = entry.op.requestBody?.content ?? {};
  if (content["application/octet-stream"]) {
    if (!left.file) throw new Error("Missing --file (path to the raw bytes)");
    body = await readBinary(left.file);
    delete left.file;
    headers["content-type"] = "application/octet-stream";
  } else if (content["application/json"]) {
    let json = {};
    if (left.json !== undefined) {
      json = JSON.parse(left.json);
      delete left.json;
    }
    const props = deref(spec, content["application/json"].schema).properties ?? {};
    for (const [name, schema] of Object.entries(props)) {
      if (left[name] === undefined) continue;
      json[name] = coerce(left[name], deref(spec, schema));
      delete left[name];
    }
    const required = deref(spec, content["application/json"].schema).required ?? [];
    for (const name of required) if (json[name] === undefined) throw new Error(`Missing --${name}`);
    body = JSON.stringify(json);
    headers["content-type"] = "application/json";
  }
  const unknown = Object.keys(left);
  if (unknown.length > 0) throw new Error(`Unknown option --${unknown[0]}`);
  const qs = query.toString();
  return { method: entry.method, url: `${base}${path}${qs ? `?${qs}` : ""}`, headers, body };
}

export function helpText(spec, entries) {
  const lines = ["pigateway <command> [--param value ...] [--json '{...}'] [--file path]", "", "Commands:"];
  const width = Math.max(...entries.map((e) => e.command.length));
  for (const e of entries) lines.push(`  ${e.command.padEnd(width)}  ${e.op.summary ?? ""}`);
  lines.push("", "pigateway help <command> shows a command's options.", "Environment: PIGATEWAY_URL (default " + (spec.servers?.[0]?.url ?? "") + "), PIGATEWAY_API_KEY.");
  return lines.join("\n");
}

export function commandHelp(spec, entry) {
  const lines = [`${entry.command}  (${entry.method} ${entry.path})`, entry.op.summary ?? ""];
  for (const param of entry.parameters) {
    const p = param.$ref ? deref(spec, param) : param;
    lines.push(`  --${p.name} <${deref(spec, p.schema).type ?? "value"}>  ${p.in}${p.required ? ", required" : ""}`);
  }
  const content = entry.op.requestBody?.content ?? {};
  if (content["application/octet-stream"]) lines.push("  --file <path>  raw body bytes, required");
  if (content["application/json"]) {
    const schema = deref(spec, content["application/json"].schema);
    for (const [name, prop] of Object.entries(schema.properties ?? {})) {
      const p = deref(spec, prop);
      lines.push(`  --${name} <${p.enum ? p.enum.join("|") : (p.type ?? "value")}>  body${(schema.required ?? []).includes(name) ? ", required" : ""}`);
    }
    lines.push("  --json '{...}'  whole body as JSON");
  }
  return lines.join("\n");
}

export async function run(argv, env, spec, { fetchImpl = fetch, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const entries = operations(spec);
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    const target = command === "help" ? entries.find((e) => e.command === rest[0]) : undefined;
    out((target ? commandHelp(spec, target) : helpText(spec, entries)) + "\n");
    return 0;
  }
  const entry = entries.find((e) => e.command === command);
  if (!entry) {
    err(`Unknown command "${command}". Run pigateway help.\n`);
    return 2;
  }
  let request;
  try {
    request = await buildRequest(spec, entry, parseFlags(rest), { baseUrl: env.PIGATEWAY_URL, apiKey: env.PIGATEWAY_API_KEY });
  } catch (e) {
    err(`${e.message}\n`);
    return 2;
  }
  let res;
  try {
    res = await fetchImpl(request.url, { method: request.method, headers: request.headers, ...(request.body !== undefined ? { body: request.body } : {}) });
  } catch (e) {
    err(`Cannot reach pigateway at ${request.url}: ${e.message}\n`);
    return 1;
  }
  if ((res.headers.get("content-type") ?? "").startsWith("text/event-stream") && res.body) {
    for await (const chunk of res.body) out(Buffer.from(chunk).toString("utf8"));
    return 0;
  }
  const text = await res.text();
  let shown = text;
  try {
    shown = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON
  }
  if (shown) out(shown + "\n");
  return res.ok ? 0 : 1;
}
