#!/usr/bin/env node
import { runCli } from "pi-better-subagents/agent-catalog.mjs";

process.exitCode = await runCli();