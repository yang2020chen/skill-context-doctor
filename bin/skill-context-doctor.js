#!/usr/bin/env node
import { main } from "../src/app.js";

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error?.stack || error?.message || String(error)}\n`);
  process.exitCode = 1;
});
