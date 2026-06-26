const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const repoRoot = join(__dirname, "..", "..");

function runNode(code, env = {}) {
  const result = spawnSync(process.execPath, ["-e", code], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ...env,
    },
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n")
  );

  return result.stdout.trim();
}

test("package dry-run includes Pi extension entrypoint", () => {
  const result = spawnSync("npm", ["pack", "--json", "--dry-run"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      npm_config_cache: mkdtempSync(join(tmpdir(), "pi-speak-npm-cache-")),
    },
    encoding: "utf8",
  });

  assert.equal(
    result.status,
    0,
    [result.stdout, result.stderr].filter(Boolean).join("\n")
  );

  const [pack] = JSON.parse(result.stdout);
  const files = new Set(pack.files.map((file) => file.path));

  assert.equal(pack.name, "pi-speak");
  assert.ok(files.has("dist/index.js"));
  assert.ok(files.has("dist/providers/MacSayProvider.js"));
  assert.ok(files.has("package.json"));
});

test("ElevenLabs initializes lazily and registers Pi controls", () => {
  const stdout = runNode(`
    const ext = require("./dist/index.js").default;
    const events = {};
    const calls = [];
    const agent = {
      hasUI: true,
      ui: {
        setStatus: (key, value) => calls.push(["status", key, value]),
        setWidget: (key, value) => calls.push(["widget", key, value]),
        notify: (message, level) => calls.push(["notify", message, level]),
      },
      on: (name, callback) => { events[name] = callback; },
      registerCommand: (name, command) => calls.push(["command", name, command.description]),
      registerShortcut: (shortcut, command) => calls.push(["shortcut", shortcut, command.description]),
    };

    (async () => {
      await ext(agent);
      console.log(JSON.stringify(calls));
      process.exit(0);
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `, {
    TTS_PROVIDER: "elevenlabs",
    ELEVENLABS_API_KEY: "dummy",
    ELEVENLABS_VOICE_ID: "dummy",
  });

  const calls = JSON.parse(stdout);

  assert.ok(calls.some((call) => call[0] === "status" && call[2] === "ready (elevenlabs)"));
  assert.ok(calls.some((call) => call[0] === "command" && call[1] === "speak-mute"));
  assert.ok(calls.some((call) => call[0] === "shortcut" && call[1] === "alt+m"));
});

test("macsay empty WAVE output fails before ffplay starts", { skip: process.platform !== "darwin" }, () => {
  const tempDir = mkdtempSync(join(tmpdir(), "pi-speak-integration-"));
  const binDir = join(tempDir, "bin");
  const ffplayMarker = join(tempDir, "ffplay-started");

  try {
    require("node:fs").mkdirSync(binDir);

    const fakeSay = join(binDir, "say");
    writeFileSync(fakeSay, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const output = args[args.indexOf("-o") + 1];
if (!output) process.exit(2);
const wav = Buffer.alloc(44);
wav.write("RIFF", 0, "ascii");
wav.writeUInt32LE(36, 4);
wav.write("WAVE", 8, "ascii");
wav.write("fmt ", 12, "ascii");
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(24000, 24);
wav.writeUInt32LE(48000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36, "ascii");
wav.writeUInt32LE(0, 40);
fs.writeFileSync(output, wav);
`);
    chmodSync(fakeSay, 0o755);

    const fakeFfplay = join(binDir, "ffplay");
    writeFileSync(fakeFfplay, `#!/usr/bin/env node
require("node:fs").writeFileSync(process.env.FAKE_FFPLAY_MARKER, "started");
process.stdin.resume();
setTimeout(() => process.exit(0), 100);
`);
    chmodSync(fakeFfplay, 0o755);

    const stdout = runNode(`
      const assert = require("node:assert/strict");
      const { existsSync } = require("node:fs");
      const ext = require("./dist/index.js").default;
      const events = {};
      const calls = [];
      const agent = {
        hasUI: true,
        ui: {
          setStatus: (key, value) => calls.push(["status", key, value]),
          setWidget: (key, value) => calls.push(["widget", key, value]),
          notify: (message, level) => calls.push(["notify", message, level]),
        },
        on: (name, callback) => { events[name] = callback; },
        registerCommand: (name, command) => calls.push(["command", name, command.description]),
        registerShortcut: (shortcut, command) => calls.push(["shortcut", shortcut, command.description]),
      };
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const hasAudioDisabled = () => calls.some((call) => call[0] === "status" && call[2] === "audio disabled");

      (async () => {
        await ext(agent);
        events["agent:message:delta"]("functional smoke test");
        events["agent:message:end"]();

        for (let attempt = 0; attempt < 20 && !hasAudioDisabled(); attempt += 1) {
          await sleep(100);
        }

        assert.ok(hasAudioDisabled());
        assert.equal(existsSync(process.env.FAKE_FFPLAY_MARKER), false);

        console.log(JSON.stringify(calls.filter((call) => call[0] === "status").map((call) => call[2])));
        process.exit(0);
      })().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    `, {
      PATH: `${binDir}:${process.env.PATH}`,
      TTS_PROVIDER: "macsay",
      FAKE_FFPLAY_MARKER: ffplayMarker,
    });

    const statuses = JSON.parse(stdout.split("\n").at(-1));
    assert.deepEqual(statuses, [null, "initializing macsay", "ready (macsay)", "macsay failed", "audio disabled"]);

    assert.throws(() => readFileSync(ffplayMarker), /ENOENT/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
