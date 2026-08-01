#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const VERSION = "1.0.0";
const REPOSITORY = "https://github.com/potatohoney-p/weasley-frame.git";

function defaultHome() {
  return resolve(process.env.WEASLEY_FRAME_HOME || join(homedir(), ".weasley", "frame"));
}

function sourceDir(home = defaultHome()) {
  return join(home, "source");
}

function printHelp() {
  console.log(`Weasley Frame ${VERSION}

Usage:
  weasley-frame doctor         Check local prerequisites
  weasley-frame install        Clone the source into the Weasley data home
  weasley-frame update         Fast-forward a clean source checkout
  weasley-frame start          Install if needed, then start the local stack
  weasley-frame stop           Stop the local stack without deleting data
  weasley-frame path           Print the managed source path
  weasley-frame --version      Print the CLI version

Environment:
  WEASLEY_FRAME_HOME           Override the default ~/.weasley/frame directory
`);
}

function runSync(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    shell: false,
    stdio: options.stdio || "pipe",
  });
}

function commandAvailable(command, args = ["--version"]) {
  const result = runSync(command, args);
  return result.status === 0;
}

function doctor() {
  const checks = [
    ["Node.js 22+", Number(process.versions.node.split(".")[0]) >= 22, process.version],
    ["Git", commandAvailable("git"), "git --version"],
    ["Docker", commandAvailable("docker"), "docker --version"],
    ["Docker Compose", commandAvailable("docker", ["compose", "version"]), "docker compose version"],
    ["GNU Make", commandAvailable("make"), "make --version"],
  ];

  for (const [label, ok, detail] of checks) {
    console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` (${detail})`}`);
  }

  const ready = checks.every(([, ok]) => ok);
  if (!ready) {
    console.error("\nInstall the missing prerequisites, then run `weasley-frame doctor` again.");
    return 1;
  }
  console.log("\nWeasley Frame is ready to install.");
  return 0;
}

function ensureCheckout({ update = false } = {}) {
  const home = defaultHome();
  const source = sourceDir(home);
  mkdirSync(home, { recursive: true });

  if (!existsSync(join(source, ".git"))) {
    if (existsSync(source)) {
      throw new Error(`${source} exists but is not a Git checkout. Move it aside or set WEASLEY_FRAME_HOME.`);
    }
    const clone = runSync("git", ["clone", "--depth=1", REPOSITORY, source], { stdio: "inherit" });
    if (clone.status !== 0) throw new Error("Unable to clone Weasley Frame.");
    return source;
  }

  if (update) {
    const status = runSync("git", ["status", "--porcelain"], { cwd: source });
    if (status.status !== 0) throw new Error("Unable to inspect the managed checkout.");
    if (status.stdout.trim()) {
      throw new Error(`Refusing to update a modified checkout at ${source}. Commit or move those changes first.`);
    }
    const pull = runSync("git", ["pull", "--ff-only"], { cwd: source, stdio: "inherit" });
    if (pull.status !== 0) throw new Error("Unable to fast-forward the managed checkout.");
  }

  return source;
}

function runMake(target) {
  const source = ensureCheckout();
  const child = spawn("make", [target], {
    cwd: source,
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  child.on("error", (error) => {
    console.error(`Unable to start GNU Make: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 1);
  });
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] || "help";

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(VERSION);
    return;
  }

  try {
    if (command === "doctor") {
      process.exitCode = doctor();
    } else if (command === "install") {
      console.log(ensureCheckout());
    } else if (command === "update") {
      console.log(ensureCheckout({ update: true }));
    } else if (command === "start") {
      runMake("dev");
    } else if (command === "stop") {
      runMake("down");
    } else if (command === "path") {
      console.log(sourceDir());
    } else {
      console.error(`Unknown command: ${command}\n`);
      printHelp();
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)))) {
  await main();
}
