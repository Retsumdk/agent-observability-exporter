#!/usr/bin/env node
import process from "node:process";
import { runCli } from "./cli.js";

runCli(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agent-obs: ${message}\n`);
    process.exitCode = 1;
  });
