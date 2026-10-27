#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { run } from "../cli/cli.mjs";

const spec = JSON.parse(await readFile(new URL("../openapi/openapi.json", import.meta.url), "utf8"));
process.exitCode = await run(process.argv.slice(2), process.env, spec);
