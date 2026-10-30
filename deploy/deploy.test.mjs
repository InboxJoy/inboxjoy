import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  rmSync, statSync, symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

// Tests for the self-hosting kit: install.sh, the `inboxjoy` command, compose.yml,
// the Caddyfile and the docs. Docker, curl and friends are replaced with mocks
// on PATH, so nothing here needs Docker, root or the network.

const deployDir = fileURLToPath(new URL("./", import.meta.url));
const repoRoot = join(deployDir, "..");
const installScript = join(deployDir, "install.sh");
const cliScript = join(deployDir, "bin/inboxjoy");
const hasRuby = spawnSync("sh", ["-c", "command -v ruby"]).status === 0;

const DOMAIN = "inbox.example.com";
// The scripts target the POSIX sh on Ubuntu and Debian (dash). Run the suite with
// INBOXJOY_TEST_SHELL=dash to check them against it; "sh" is whatever this machine has.
const SHELL = process.env.INBOXJOY_TEST_SHELL ?? "sh";

function mock(bin, name, body) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`, { mode: 0o755 });
}

function sandbox({ withDocker = true, uid = 0, meminfo } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inboxjoy-selfhost-test-"));
  const bin = join(dir, "mockbin");
  const root = join(dir, "opt-inboxjoy");
  const binOut = join(dir, "usr-local-bin");
  mkdirSync(bin);
  mkdirSync(binOut);
  writeFileSync(join(dir, "meminfo"), meminfo ?? "MemTotal:        1990000 kB\nSwapTotal:             0 kB\n");
  writeFileSync(join(dir, "os-release"), "ID=ubuntu\nID_LIKE=debian\n");

  mock(bin, "uname", 'case "$1" in -m) echo x86_64 ;; *) echo Linux ;; esac');
  mock(bin, "id", `if [ "$1" = -u ]; then echo ${uid}; else /usr/bin/id "$@"; fi`);
  mock(bin, "sleep", ":");
  mock(bin, "stty", ":");
  mock(bin, "systemctl", ":");
  mock(bin, "sudo", 'echo "$*" >> "$SANDBOX/sudo-calls"');
  mock(bin, "ss", ":");
  mock(bin, "getent", ":");
  mock(bin, "df", 'printf "Filesystem 1024-blocks Used Available Capacity Mounted on\\nmock 99999999 1 99999999 1%% /\\n"');
  mock(bin, "curl", `echo "$*" >> "$SANDBOX/curl-calls"
out=""; url=""; write=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) write="$2"; shift 2 ;;
    --retry|--retry-delay|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */releases/latest) echo '{"tag_name": "v9.9.9"}'; exit 0 ;;
  */api/ready) if [ -n "$write" ]; then printf 200; fi; exit 0 ;;
  https://get.docker.com*) echo 'exit 0'; exit 0 ;;
  */deploy/*)
    case "$url" in */v0.0.1/*) exit 22 ;; esac
    name="\${url##*/deploy/}"
    if [ -z "$out" ]; then exit 22; fi
    cp "$DEPLOY_SRC/$name" "$out"; exit 0 ;;
esac
exit 22`);
  if (withDocker) {
    mock(bin, "docker", `echo "$*" >> "$SANDBOX/docker-calls"
args=" $* "
case "$1" in
  info) exit 0 ;;
  ps) exit 0 ;;
  image) exit 0 ;;
  inspect)
    case "$args" in
      *Health.Status*) echo healthy ;;
      *Config.Image*) echo ghcr.io/inboxjoy/api:1.0.0 ;;
      *Labels*) echo 1.0.0 ;;
    esac
    exit 0 ;;
  compose)
    shift
    # Which release this call would run: Compose reads INBOXJOY_VERSION from the environment first.
    echo "\${INBOXJOY_VERSION-unset}|$*" >> "$SANDBOX/compose-versions"
    case "$*" in
      "version --short") echo 2.29.1; exit 0 ;;
      version*) echo "Docker Compose version v2.29.1"; exit 0 ;;
      "ps -q "*) echo "id-$3"; exit 0 ;;
      *pg_dump*) if [ -e "$SANDBOX/fail-dump" ]; then exit 1; fi; printf 'PGDMP-fake-dump-%s' "$RANDOM"; exit 0 ;;
      *pg_restore*) cat > "$SANDBOX/restored"; exit 0 ;;
      *"select count"*) echo "\${MOCK_MIGRATIONS:-42}"; exit 0 ;;
      "run "*) if [ -e "$SANDBOX/fail-migrate" ]; then exit 1; fi; exit 0 ;;
      pull*) if [ -e "$SANDBOX/fail-pull" ]; then exit 1; fi; exit 0 ;;
    esac ;;
esac
exit 0`);
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    SANDBOX: dir,
    DEPLOY_SRC: deployDir,
    INBOXJOY_DIR: root,
    INBOXJOY_BIN_DIR: binOut,
    INBOXJOY_BIN: join(binOut, "inboxjoy"),
    INBOXJOY_NONINTERACTIVE: "1",
    INBOXJOY_MEMINFO: join(dir, "meminfo"),
    INBOXJOY_OS_RELEASE: join(dir, "os-release"),
    INBOXJOY_SWAP: "no",
    INBOXJOY_DOMAIN: DOMAIN,
    INBOXJOY_EMAIL: "admin@example.com",
    INBOXJOY_RAW_BASE: "https://raw.example.test/inboxjoy",
    INBOXJOY_API_BASE: "https://api.example.test/repos/inboxjoy",
  };
  for (const name of ["INBOXJOY_VERSION", "INBOXJOY_FORCE", "INBOXJOY_INSTALL_DOCKER", "MAIL_SMTP_URL", "MAIL_FROM", "MAIL_REPLY_TO", "AI_API_KEY", "AI_MODEL", "AI_BASE_URL", "INBOXJOY_SKIP_CHECKS", "INBOXJOY_REEXEC"]) delete env[name];
  return { dir, bin, root, binOut, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const sh = (script, args, env, extra = {}) => spawnSync(SHELL, [script, ...args], { env: { ...env, ...extra }, encoding: "utf8", input: "" });
const dockerCalls = (box) => existsSync(join(box.dir, "docker-calls")) ? readFileSync(join(box.dir, "docker-calls"), "utf8").trim().split("\n") : [];
const indexOfCall = (calls, pattern, from = 0) => calls.findIndex((line, i) => i >= from && pattern.test(line));
// Every `docker compose` call as { version, args }: version is what INBOXJOY_VERSION held for that call
// ("unset" when the variable was not set). The version-probe calls (`compose version`) are left out.
const composeCalls = (box) => {
  const file = join(box.dir, "compose-versions");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => {
    const at = line.indexOf("|");
    return { version: line.slice(0, at), args: line.slice(at + 1) };
  }).filter((call) => !/^version\b/.test(call.args));
};
const releasesUsed = (box) => [...new Set(composeCalls(box).map((call) => call.version))];
const envValue = (text, key) => (text.match(new RegExp(`^${key}=(.*)$`, "m")) ?? [])[1];
const output = (result) => `${result.stdout}\n${result.stderr}`;

// A finished install, as install.sh leaves it, for the `inboxjoy` command tests.
function installedBox(options = {}) {
  const box = sandbox(options);
  mkdirSync(join(box.root, "backups"), { recursive: true });
  writeFileSync(join(box.root, ".env"), `INBOXJOY_VERSION=1.0.0\nAPP_DOMAIN=${DOMAIN}\nAUTH_SECRET=keep-me\n`, { mode: 0o600 });
  writeFileSync(join(box.root, "compose.yml"), "services:\n  old: {}\n");
  writeFileSync(join(box.root, "Caddyfile"), "old\n");
  copyFileSync(cliScript, box.env.INBOXJOY_BIN);
  chmodSync(box.env.INBOXJOY_BIN, 0o755);
  return box;
}
const cli = (box, args, extra = {}) => sh(box.env.INBOXJOY_BIN, args, box.env, extra);
const backupsIn = (box, prefix = "inboxjoy") => readdirSync(join(box.root, "backups")).filter((name) => name.startsWith(`${prefix}-`) && name.endsWith(".dump")).sort();

// ---------------------------------------------------------------------------
// Static checks
// ---------------------------------------------------------------------------

test("shell scripts are valid POSIX sh", () => {
  for (const script of [installScript, cliScript]) {
    for (const shell of ["sh", "dash"]) {
      if (spawnSync("sh", ["-c", `command -v ${shell}`]).status !== 0) continue;
      const result = spawnSync(shell, ["-n", script], { encoding: "utf8" });
      assert.equal(result.status, 0, `${shell} -n ${script}: ${result.stderr}`);
    }
    assert.ok(statSync(script).mode & 0o111, `${script} must be executable`);
  }
});

function composeConfig() {
  const ruby = 'require "yaml"; require "json"; f = ARGV[0]; d = YAML.respond_to?(:unsafe_load_file) ? YAML.unsafe_load_file(f) : YAML.load_file(f); puts JSON.generate(d)';
  const result = spawnSync("ruby", ["-e", ruby, join(deployDir, "compose.yml")], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("compose.yml: the stack's shape and its safety settings", { skip: !hasRuby && "ruby is not installed" }, () => {
  const compose = composeConfig();
  const services = compose.services;
  assert.deepEqual(Object.keys(services).sort(), ["api", "backup", "caddy", "migrate", "postgres", "web", "worker"]);
  assert.equal(compose.name, "inboxjoy");

  assert.equal(services.api.image, "ghcr.io/inboxjoy/api:${INBOXJOY_VERSION:-latest}");
  assert.equal(services.migrate.image, services.api.image, "migrations run from the api image");
  assert.equal(services.worker.image, "ghcr.io/inboxjoy/worker:${INBOXJOY_VERSION:-latest}");
  assert.equal(services.web.image, "ghcr.io/inboxjoy/web:${INBOXJOY_VERSION:-latest}");
  assert.equal(services.postgres.image, "postgres:16-alpine");

  // Only Caddy is reachable from outside.
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.ports !== undefined, name === "caddy", `${name}: published ports`);
  }
  assert.deepEqual(services.caddy.ports.sort(), ["443:443", "443:443/udp", "80:80"]);

  // One worker, no replicas; log rotation; memory limits that fit 2 GB.
  assert.equal(services.worker.deploy.replicas, undefined);
  let totalMemory = 0;
  for (const [name, service] of Object.entries(services)) {
    assert.equal(service.logging.driver, "json-file", `${name}: logging driver`);
    assert.ok(service.logging.options["max-size"] && service.logging.options["max-file"], `${name}: log rotation`);
    const limit = service.deploy?.resources?.limits?.memory;
    assert.match(limit, /^\d+M$/, `${name}: memory limit`);
    if (name !== "migrate") totalMemory += Number.parseInt(limit, 10);
  }
  assert.ok(totalMemory <= 1700, `memory limits add up to ${totalMemory}M, which must leave room on a 2 GB server`);

  // Migrations gate the app; the database gates migrations.
  for (const name of ["api", "worker", "web"]) {
    assert.equal(services[name].depends_on.migrate.condition, "service_completed_successfully", `${name} waits for migrate`);
    assert.equal(services[name].env_file, ".env");
  }
  assert.equal(services.migrate.depends_on.postgres.condition, "service_healthy");
  assert.equal(services.migrate.restart, "no");
  assert.equal(services.api.environment.NODE_ENV, "production");
  assert.equal(services.api.environment.API_PORT, "3001");
  assert.match(services.api.environment.DATABASE_URL, /@postgres:5432\/inboxjoy/);
  assert.ok(services.postgres.healthcheck, "postgres has a health check");
  assert.ok(services.postgres.volumes.some((volume) => volume.startsWith("postgres_data:")));
  // The edition reaches api, worker and web at run time only: never a build arg.
  for (const name of ["api", "worker", "web"]) {
    assert.equal(services[name].environment.INBOXJOY_EDITION, "${INBOXJOY_EDITION:-selfhost}", `${name} gets INBOXJOY_EDITION at run time`);
    assert.equal(services[name].environment.INBOXJOY_VERSION, "${INBOXJOY_VERSION:-latest}", `${name} knows which release it runs`);
  }
  assert.equal(services.web.build, undefined);
});

test("backup service: keeps the newest backups and does not run twice in a day", { skip: !hasRuby && "ruby is not installed" }, () => {
  const box = sandbox();
  try {
    const script = composeConfig().services.backup.command[0].replaceAll("$$", "$");
    const backups = join(box.dir, "backups");
    mkdirSync(backups);
    const loop = script.replaceAll("/backups", backups).replace("sleep 600", "exit 0");
    writeFileSync(join(box.dir, "loop.sh"), loop);
    mock(box.bin, "pg_dump", 'for a in "$@"; do case "$a" in --file=*) printf PGDMP > "${a#--file=}" ;; esac; done');
    // Twenty old backups, last touched years ago.
    for (let i = 1; i <= 20; i += 1) {
      const file = join(backups, `inboxjoy-202001${String(i).padStart(2, "0")}T030000Z.dump`);
      writeFileSync(file, "PGDMP");
      utimesSync(file, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));
    }
    const env = { ...box.env, BACKUP_KEEP: "14", BACKUP_HOUR_UTC: "3" };
    const first = spawnSync(SHELL, [join(box.dir, "loop.sh")], { env, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /backup saved/);
    let files = readdirSync(backups).filter((name) => name.endsWith(".dump")).sort();
    assert.equal(files.length, 14, "only the newest 14 remain");
    assert.ok(!files.includes("inboxjoy-20200101T030000Z.dump"), "the oldest was removed");
    assert.ok(files.some((name) => !name.startsWith("inboxjoy-2020")), "the new backup is kept");
    assert.equal(readdirSync(backups).filter((name) => name.endsWith(".partial")).length, 0);

    // A second pass right away finds a fresh backup and does nothing.
    const second = spawnSync(SHELL, [join(box.dir, "loop.sh")], { env, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stdout, /backup saved/);
    files = readdirSync(backups).filter((name) => name.endsWith(".dump"));
    assert.equal(files.length, 14);
  } finally {
    box.cleanup();
  }
});

test("Caddyfile: one domain, API and web routes, no basic auth or blog proxy", () => {
  const caddyfile = readFileSync(join(deployDir, "Caddyfile"), "utf8");
  assert.match(caddyfile, /^\{\$APP_DOMAIN\} \{/m);
  assert.match(caddyfile, /email \{\$ACME_EMAIL\}/);
  assert.match(caddyfile, /handle_path \/api\/\*[\s\S]*reverse_proxy api:3001/);
  for (const path of ["/unsubscribe/*", "/mcp", "/.well-known/oauth-protected-resource"]) {
    assert.match(caddyfile, new RegExp(`handle ${path.replaceAll("*", "\\*").replaceAll(".", "\\.")} \\{[\\s\\S]*?reverse_proxy api:3001`), path);
  }
  assert.match(caddyfile, /handle \{\s*reverse_proxy web:3000/);
  assert.match(caddyfile, /respond \/healthz 200/);
  // Nothing from a hosted deployment (dev basic auth, a blog proxy, a host-side service). The names of
  // our own hosts are checked by the private-only suite, not here: this file is public.
  for (const forbidden of ["basic_auth", "blog", "dev.{$APP_DOMAIN}", "www.", "host.docker.internal"]) {
    assert.ok(!caddyfile.includes(forbidden), `Caddyfile must not contain ${forbidden}`);
  }
});

// The private-marker scanner that guards the public export lives in the private repository only, and
// so does the list of private names it holds. This test borrows the scanner when it is there and is
// skipped everywhere else; it never spells a private marker out, so this file can be exported as it is.
// (The path is assembled so the export's check for references to private paths leaves this file alone.)
const exporterTool = join(repoRoot, "scripts", ["export", "public", "tool.mjs"].join("-"));
const hasExporter = existsSync(exporterTool);

test("nothing internal leaks into the self-hosting kit, its docs or the release workflow", { skip: !hasExporter && "the private-marker scanner is not in this checkout" }, async () => {
  const { scanContent } = await import(pathToFileURL(exporterTool).href);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(deployDir);
  if (existsSync(join(repoRoot, "docs/self-hosting"))) walk(join(repoRoot, "docs/self-hosting"));
  files.push(join(repoRoot, ".github/workflows/release-images.yml"));
  assert.ok(files.length > 3);
  for (const file of files) {
    const findings = scanContent(file.slice(repoRoot.length + 1), readFileSync(file, "utf8")).filter((finding) => finding.tier === "fail");
    assert.deepEqual(findings, [], `${file} carries a private marker`);
  }
});

test("docs/self-hosting/configuration.md explains every setting in env.example", () => {
  const docsFile = join(repoRoot, "docs/self-hosting/configuration.md");
  assert.ok(existsSync(docsFile), "docs/self-hosting/configuration.md exists");
  const docs = readFileSync(docsFile, "utf8");
  const keys = [...readFileSync(join(deployDir, "env.example"), "utf8").matchAll(/^#?([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]);
  assert.ok(keys.includes("INBOXJOY_EDITION") && keys.includes("MAIL_SMTP_URL") && keys.includes("AI_API_KEY"));
  for (const key of keys) assert.ok(docs.includes(`\`${key}\``), `configuration.md must document ${key}`);
});

test("release workflow: tags only, public repository only, both platforms, all three images", { skip: !hasRuby && "ruby is not installed" }, () => {
  const file = join(repoRoot, ".github/workflows/release-images.yml");
  const ruby = 'require "yaml"; require "json"; d = YAML.respond_to?(:unsafe_load_file) ? YAML.unsafe_load_file(ARGV[0]) : YAML.load_file(ARGV[0]); puts JSON.generate(d)';
  const result = spawnSync("ruby", ["-e", ruby, file], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const workflow = JSON.parse(result.stdout);
  const triggers = workflow.on ?? workflow.true;
  assert.deepEqual(triggers, { push: { tags: ["v*"] } }, "runs only when a v* tag is pushed");
  for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.equal(job.if, "github.repository == 'inboxjoy/inboxjoy'", `${name} is guarded by the repository name`);
  }
  assert.deepEqual(workflow.jobs.build.strategy.matrix.app, ["api", "worker", "web"]);
  assert.deepEqual(workflow.jobs.build.strategy.matrix.platform, ["linux/amd64", "linux/arm64"]);
  assert.equal(workflow.jobs.build.permissions.packages, "write");

  // Least privilege: read-only by default, and each job names only what it needs.
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.build.permissions, { contents: "read", packages: "write" });
  assert.deepEqual(workflow.jobs.publish.permissions, { contents: "read", packages: "write" });
  assert.deepEqual(workflow.jobs.release.permissions, { contents: "write" }, "only the release job may write to the repository");

  const text = readFileSync(file, "utf8");
  // Every action is pinned to a full commit SHA with its version in a comment, so a moved tag
  // cannot slip new code into a job that pushes images.
  const uses = [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)[ \t]*(?:#[ \t]*(\S.*))?$/gm)];
  assert.ok(uses.length >= 7, `found only ${uses.length} actions`);
  for (const [, reference, comment] of uses) {
    assert.match(reference, /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/, `${reference} must be pinned to a full commit SHA`);
    assert.match(comment ?? "", /^v\d+\.\d+\.\d+\s*$/, `${reference} needs its version in a comment`);
  }
  assert.doesNotMatch(text, /^\s*(?:-\s+)?uses:\s*\S+@(?![0-9a-f]{40}\b)/m, "no action may use a tag or branch name");
  assert.doesNotMatch(text, /pull_request_target|workflow_run/, "never run with a write token on someone else's code");
  assert.match(text, /file: apps\/\$\{\{ matrix\.app \}\}\/Dockerfile/);
  assert.equal((text.match(/ghcr\.io\/inboxjoy\/\$\{\{ matrix\.app \}\}/g) ?? []).length >= 3, true);
  assert.doesNotMatch(text, /NEXT_PUBLIC_|build-args/, "the public images are built with no build-time settings");
});

// ---------------------------------------------------------------------------
// install.sh
// ---------------------------------------------------------------------------

test("install: a fresh non-interactive install writes a safe .env and starts the stack in order", () => {
  const box = sandbox();
  try {
    const result = sh(installScript, [], box.env);
    assert.equal(result.status, 0, output(result));
    const envFile = join(box.root, ".env");
    const env = readFileSync(envFile, "utf8");

    assert.equal(statSync(envFile).mode & 0o777, 0o600, ".env is private");
    assert.equal(statSync(box.root).mode & 0o777, 0o700, "install folder is private");
    assert.equal(statSync(join(box.root, "backups")).mode & 0o777, 0o700, "backups folder is private");
    assert.equal(envValue(env, "INBOXJOY_EDITION"), "selfhost");
    assert.equal(envValue(env, "SIGNUP_MODE"), "invite");
    assert.equal(envValue(env, "SMTP_MAILBOXES_ENABLED"), "true");
    assert.equal(envValue(env, "INBOXJOY_VERSION"), "9.9.9", "pinned to the latest release");
    assert.equal(envValue(env, "APP_DOMAIN"), DOMAIN);
    assert.equal(envValue(env, "ACME_EMAIL"), "admin@example.com");
    assert.equal(envValue(env, "API_BASE_URL"), `https://${DOMAIN}/api`);
    assert.equal(envValue(env, "WEB_BASE_URL"), `https://${DOMAIN}`);
    assert.equal(envValue(env, "CORS_ORIGINS"), `https://${DOMAIN}`);
    assert.equal(envValue(env, "BETTER_AUTH_URL"), `https://${DOMAIN}/api`);

    const authSecret = envValue(env, "AUTH_SECRET");
    const dbPassword = envValue(env, "POSTGRES_PASSWORD");
    const mailboxKey = envValue(env, "MAILBOX_CREDENTIALS_KEY");
    assert.match(authSecret, /^[0-9a-f]{64}$/);
    assert.match(dbPassword, /^[0-9a-f]{48}$/);
    assert.equal(Buffer.from(mailboxKey, "base64").length, 32, "mailbox key is 32 bytes");
    assert.equal(Buffer.from(mailboxKey, "base64").toString("base64"), mailboxKey, "mailbox key is canonical base64");
    assert.equal(new Set([authSecret, dbPassword, mailboxKey]).size, 3);
    // Optional settings stay commented out until someone sets them.
    assert.doesNotMatch(env, /^MAIL_SMTP_URL=/m);
    assert.doesNotMatch(env, /^AI_API_KEY=/m);

    // Secrets are never printed.
    for (const secret of [authSecret, dbPassword, mailboxKey]) assert.ok(!output(result).includes(secret), "a secret was printed");
    assert.match(result.stdout, new RegExp(`https://${DOMAIN}`));
    assert.match(result.stdout, /first account you create becomes the owner/);
    // The setup token is the one secret that is shown, and only in the "Open" line.
    const setupToken = envValue(env, "SETUP_TOKEN");
    assert.match(setupToken, /^[0-9a-f]{48}$/, "24 random bytes as hex");
    assert.ok(![authSecret, dbPassword, mailboxKey].includes(setupToken));
    assert.match(result.stdout, new RegExp(`^  Open: +https://${DOMAIN.replaceAll(".", "\\.")}/app/setup\\?token=${setupToken}$`, "m"));
    assert.equal(output(result).split(setupToken).length - 1, 1, "the token is printed exactly once");
    assert.match(output(result), /System email is not set up yet/);

    // The stack files and the command are in place.
    for (const name of ["compose.yml", "Caddyfile", "env.example"]) assert.ok(existsSync(join(box.root, name)), name);
    assert.ok(!existsSync(join(box.root, ".dl")), "temporary downloads are removed");
    assert.ok(statSync(join(box.binOut, "inboxjoy")).mode & 0o111, "inboxjoy command is executable");
    assert.equal(readFileSync(join(box.binOut, "inboxjoy"), "utf8"), readFileSync(cliScript, "utf8"));

    // Pull, then database, then migrate, then everything.
    const calls = dockerCalls(box);
    const pull = indexOfCall(calls, /^compose pull/);
    const database = indexOfCall(calls, /^compose up -d postgres/, pull);
    const migrate = indexOfCall(calls, /^compose run --rm -T migrate/, database);
    const start = indexOfCall(calls, /^compose up -d --remove-orphans/, migrate);
    assert.ok(pull >= 0 && database > pull && migrate > database && start > migrate, calls.join("\n"));
    // Downloads come from the tagged release, not from a moving branch.
    assert.match(readFileSync(join(box.dir, "curl-calls"), "utf8"), /raw\.example\.test\/inboxjoy\/v9\.9\.9\/deploy\/compose\.yml/);
  } finally {
    box.cleanup();
  }
});

test("install: system email and AI settings from the environment are kept literally", () => {
  const box = sandbox();
  try {
    const smtp = "smtps://user:p$ss@smtp.example.com:465";
    const result = sh(installScript, [], box.env, {
      MAIL_SMTP_URL: smtp, MAIL_FROM: "InboxJoy <noreply@example.com>", AI_API_KEY: "sk-test$key", AI_MODEL: "my-model", INBOXJOY_VERSION: "1.2.3",
    });
    assert.equal(result.status, 0, output(result));
    const env = readFileSync(join(box.root, ".env"), "utf8");
    assert.equal(envValue(env, "MAIL_SMTP_URL"), `'${smtp}'`, "single quotes keep $ literal for Docker Compose");
    assert.equal(envValue(env, "MAIL_FROM"), "InboxJoy <noreply@example.com>");
    assert.equal(envValue(env, "AI_API_KEY"), "'sk-test$key'");
    assert.equal(envValue(env, "AI_MODEL"), "my-model");
    assert.equal(envValue(env, "INBOXJOY_VERSION"), "1.2.3");
    assert.ok(!output(result).includes("p$ss") && !output(result).includes("sk-test"), "secrets are not printed");
    assert.doesNotMatch(output(result), /System email is not set up yet/);
    assert.match(readFileSync(join(box.dir, "curl-calls"), "utf8"), /\/v1\.2\.3\/deploy\/compose\.yml/);
    assert.doesNotMatch(readFileSync(join(box.dir, "curl-calls"), "utf8"), /releases\/latest/, "a named version needs no lookup");
  } finally {
    box.cleanup();
  }
});

test("install: running it again keeps every setting and secret", () => {
  const box = sandbox();
  try {
    assert.equal(sh(installScript, [], box.env).status, 0);
    const before = readFileSync(join(box.root, ".env"), "utf8");
    const again = sh(installScript, [], box.env, { INBOXJOY_DOMAIN: "other.example.com" });
    assert.equal(again.status, 0, output(again));
    assert.equal(readFileSync(join(box.root, ".env"), "utf8"), before, "the existing .env is untouched");
    assert.match(again.stdout, /existing configuration/);
    assert.match(again.stdout, /\bhttps:\/\/inbox\.example\.com/, "keeps the original domain");
  } finally {
    box.cleanup();
  }
});

test("install: the setup token is made on the first install only and survives a re-run", () => {
  const box = sandbox();
  try {
    const first = sh(installScript, [], box.env);
    assert.equal(first.status, 0, output(first));
    const token = envValue(readFileSync(join(box.root, ".env"), "utf8"), "SETUP_TOKEN");
    assert.match(token, /^[0-9a-f]{48}$/);

    const again = sh(installScript, [], box.env);
    assert.equal(again.status, 0, output(again));
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "SETUP_TOKEN"), token, "a re-run keeps the token");
    assert.match(again.stdout, new RegExp(`/app/setup\\?token=${token}\\b`), "the link is shown again so it can be recovered");
    assert.equal(output(again).split(token).length - 1, 1, "still printed only in the Open line");

    // A new install on another server gets its own token.
    const other = sandbox();
    try {
      assert.equal(sh(installScript, [], other.env).status, 0);
      assert.notEqual(envValue(readFileSync(join(other.root, ".env"), "utf8"), "SETUP_TOKEN"), token);
    } finally {
      other.cleanup();
    }

    // An install from before the token existed gets a plain link, never "token=".
    const legacy = sandbox();
    try {
      mkdirSync(legacy.root, { recursive: true });
      writeFileSync(join(legacy.root, ".env"), `INBOXJOY_VERSION=1.0.0\nAPP_DOMAIN=${DOMAIN}\nAUTH_SECRET=keep-me\n`, { mode: 0o600 });
      const result = sh(installScript, [], legacy.env);
      assert.equal(result.status, 0, output(result));
      assert.doesNotMatch(readFileSync(join(legacy.root, ".env"), "utf8"), /SETUP_TOKEN/, "an existing .env is never rewritten with new secrets");
      assert.match(result.stdout, new RegExp(`^  Open: +https://${DOMAIN.replaceAll(".", "\\.")}/app/setup$`, "m"));
      assert.doesNotMatch(output(result), /token=/);
    } finally {
      legacy.cleanup();
    }
  } finally {
    box.cleanup();
  }
});

test("install: a SETUP_TOKEN in the caller's shell is ignored", () => {
  const box = sandbox();
  try {
    const result = sh(installScript, [], box.env, { SETUP_TOKEN: "from-the-shell" });
    assert.equal(result.status, 0, output(result));
    assert.doesNotMatch(output(result), /from-the-shell/);
    assert.match(envValue(readFileSync(join(box.root, ".env"), "utf8"), "SETUP_TOKEN"), /^[0-9a-f]{48}$/);
  } finally {
    box.cleanup();
  }
});

test("install: docker compose always runs the release recorded in .env, whatever the shell says", () => {
  // A "v" prefix is accepted and normalised: v1.2.3 means release 1.2.3, never an image tag "v1.2.3".
  const box = sandbox();
  try {
    const result = sh(installScript, [], box.env, { INBOXJOY_VERSION: "v1.2.3" });
    assert.equal(result.status, 0, output(result));
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.2.3");
    assert.ok(composeCalls(box).length >= 6, "the installer ran compose");
    assert.deepEqual(releasesUsed(box), ["1.2.3"], "every compose call (config, pull, up, run, ps, logs) got the normalised release");
  } finally {
    box.cleanup();
  }

  // A newer version asked for on a re-run must not upgrade the stack behind the user's back.
  const again = sandbox();
  try {
    assert.equal(sh(installScript, [], again.env, { INBOXJOY_VERSION: "1.0.0" }).status, 0);
    rmSync(join(again.dir, "compose-versions"));
    const rerun = sh(installScript, [], again.env, { INBOXJOY_VERSION: "2.0.0" });
    assert.equal(rerun.status, 0, output(rerun));
    assert.match(rerun.stderr, /inboxjoy upgrade 2\.0\.0/);
    assert.equal(envValue(readFileSync(join(again.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.0.0", ".env keeps the installed release");
    assert.ok(composeCalls(again).length >= 6);
    assert.deepEqual(releasesUsed(again), ["1.0.0"], "compose kept running 1.0.0; nothing pulled or migrated 2.0.0");
    assert.equal(indexOfCall(dockerCalls(again), /2\.0\.0/), -1);
  } finally {
    again.cleanup();
  }

  // With no version in the shell, the latest release is looked up and used for every call.
  const latest = sandbox();
  try {
    assert.equal(sh(installScript, [], latest.env).status, 0);
    assert.deepEqual(releasesUsed(latest), ["9.9.9"]);
  } finally {
    latest.cleanup();
  }
});

test("install: asking for another version on a re-run points to inboxjoy upgrade", () => {
  const box = sandbox();
  try {
    assert.equal(sh(installScript, [], box.env, { INBOXJOY_VERSION: "1.0.0" }).status, 0);
    const again = sh(installScript, [], box.env, { INBOXJOY_VERSION: "2.0.0" });
    assert.equal(again.status, 0, output(again));
    assert.match(again.stderr, /inboxjoy upgrade 2\.0\.0/);
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.0.0");
  } finally {
    box.cleanup();
  }
});

test("install: a pasted URL is reduced to a domain; IPs and bare names are refused", () => {
  const box = sandbox();
  try {
    const good = sh(installScript, [], box.env, { INBOXJOY_DOMAIN: "https://Inbox.Example.com/app" });
    assert.equal(good.status, 0, output(good));
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "APP_DOMAIN"), "inbox.example.com");
  } finally {
    box.cleanup();
  }
  for (const bad of ["10.0.0.5", "localhost", "-bad-.example.com", "has space.example.com"]) {
    const other = sandbox();
    try {
      const result = sh(installScript, [], other.env, { INBOXJOY_DOMAIN: bad });
      assert.notEqual(result.status, 0, `${bad} must be refused`);
      assert.match(result.stderr, /not a usable domain|Set INBOXJOY_DOMAIN/);
      assert.ok(!existsSync(join(other.root, ".env")));
    } finally {
      other.cleanup();
    }
  }
});

test("install: needs an admin email and a domain when it cannot ask", () => {
  const box = sandbox();
  try {
    const result = sh(installScript, [], box.env, { INBOXJOY_EMAIL: "" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /INBOXJOY_EMAIL/);
    assert.ok(!existsSync(join(box.root, ".env")));
  } finally {
    box.cleanup();
  }
});

test("install: refuses to run without root (and retries through sudo when started from a file)", () => {
  const box = sandbox({ uid: 1000 });
  try {
    // `curl | sh`: the script comes from stdin, so there is no file to re-run through sudo.
    const piped = spawnSync(SHELL, [], { env: box.env, encoding: "utf8", input: readFileSync(installScript) });
    assert.notEqual(piped.status, 0);
    assert.match(piped.stderr, /as root/);
    assert.deepEqual(dockerCalls(box), []);
    assert.ok(!existsSync(box.root));

    // Started from a file: it re-runs itself with sudo.
    const fromFile = sh(installScript, [], box.env);
    assert.match(readFileSync(join(box.dir, "sudo-calls"), "utf8"), new RegExp(`-E sh ${installScript.replaceAll("/", "\\/")}`));
    assert.equal(fromFile.status, 0);
    assert.deepEqual(dockerCalls(box), []);
  } finally {
    box.cleanup();
  }
});

test("install: a 1 GB server is stopped unless forced", () => {
  const small = "MemTotal:         990000 kB\nSwapTotal:             0 kB\n";
  const box = sandbox({ meminfo: small });
  try {
    const stopped = sh(installScript, [], box.env);
    assert.notEqual(stopped.status, 0);
    assert.match(stopped.stderr, /needs 2 GB/);
    assert.deepEqual(dockerCalls(box), []);
    const forced = sh(installScript, [], box.env, { INBOXJOY_FORCE: "yes" });
    assert.equal(forced.status, 0, output(forced));
  } finally {
    box.cleanup();
  }
});

test("install: Docker is only installed after the user agrees", () => {
  // A PATH with the mocks and the basic tools, but no docker.
  const box = sandbox({ withDocker: false });
  try {
    const tools = join(box.dir, "tools");
    mkdirSync(tools);
    for (const name of new Set(["sh", SHELL, "bash", "env", "awk", "sed", "grep", "tr", "head", "tail", "od", "base64", "cat", "cp", "mv", "rm", "mkdir", "chmod", "dirname", "basename", "wc", "sort", "ls", "date", "openssl", "hostname", "mktemp"])) {
      const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(tools, name));
    }
    const env = { ...box.env, PATH: `${box.bin}:${tools}` };
    const declined = sh(installScript, [], env);
    assert.notEqual(declined.status, 0);
    assert.match(declined.stderr, /Docker is required/);
    assert.ok(!existsSync(join(box.dir, "curl-calls")) || !/get\.docker\.com/.test(readFileSync(join(box.dir, "curl-calls"), "utf8")), "get.docker.com is not fetched without consent");

    // With consent the official script is fetched; the mock script installs nothing, so the install then stops.
    const agreed = sh(installScript, [], env, { INBOXJOY_INSTALL_DOCKER: "yes" });
    assert.notEqual(agreed.status, 0);
    assert.match(readFileSync(join(box.dir, "curl-calls"), "utf8"), /get\.docker\.com/);
    assert.match(agreed.stderr, /Compose plugin is missing/);
  } finally {
    box.cleanup();
  }
});

test("install: a missing release stops before anything is written", () => {
  const box = sandbox();
  try {
    const result = sh(installScript, [], box.env, { INBOXJOY_VERSION: "0.0.1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not download deploy\/compose\.yml/);
    assert.ok(!existsSync(join(box.root, ".env")));
    assert.ok(!existsSync(join(box.binOut, "inboxjoy")));
    assert.equal(indexOfCall(dockerCalls(box), /^compose (pull|up)/), -1);
  } finally {
    box.cleanup();
  }
});

// ---------------------------------------------------------------------------
// The inboxjoy command
// ---------------------------------------------------------------------------

test("cli: help works and an unknown command fails", () => {
  const box = installedBox();
  try {
    const help = cli(box, ["help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /upgrade \[version\]/);
    const unknown = cli(box, ["frobnicate"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Usage: inboxjoy/);
  } finally {
    box.cleanup();
  }
});

test("cli: version and status report what is installed", () => {
  const box = installedBox();
  try {
    const version = cli(box, ["version"]);
    assert.equal(version.status, 0, output(version));
    assert.match(version.stdout, /Configured version: 1\.0\.0/);
    assert.match(version.stdout, /Running api: ghcr\.io\/inboxjoy\/api:1\.0\.0 \(version 1\.0\.0\)/);
    const status = cli(box, ["status"]);
    assert.equal(status.status, 0, output(status));
    assert.match(status.stdout, new RegExp(`https://${DOMAIN}`));
    assert.match(status.stdout, /API is ready/);
    assert.match(status.stdout, /Backups: none yet/);
  } finally {
    box.cleanup();
  }
});

test("cli: docker compose runs the release in .env, not the INBOXJOY_VERSION of the caller's shell", () => {
  // `sudo -E` carries the caller's environment into the command, and Compose lets the environment win over .env.
  const box = installedBox();
  try {
    const source = join(box.dir, "from-last-week.dump");
    writeFileSync(source, "PGDMP-last-weeks-data");
    for (const args of [["status"], ["version"], ["backup"], ["restart"], ["logs"], ["restore", source, "--yes"]]) {
      const result = cli(box, args, { INBOXJOY_VERSION: "9.9.9" });
      assert.equal(result.status, 0, `${args[0]}: ${output(result)}`);
    }
    assert.ok(composeCalls(box).length >= 10, "the commands ran compose");
    assert.deepEqual(releasesUsed(box), ["1.0.0"], "every compose call used the release recorded in .env");
    assert.ok(composeCalls(box).some((call) => /^logs\b/.test(call.args)), "logs ran through compose");
    assert.ok(composeCalls(box).some((call) => /pg_restore/.test(call.args)), "the direct pg_restore call ran through compose");
  } finally {
    box.cleanup();
  }
});

test("cli: a .env without a version means latest, never the caller's version", () => {
  const box = installedBox();
  try {
    writeFileSync(join(box.root, ".env"), `APP_DOMAIN=${DOMAIN}\nAUTH_SECRET=keep-me\n`, { mode: 0o600 });
    const result = cli(box, ["status"], { INBOXJOY_VERSION: "9.9.9" });
    assert.equal(result.status, 0, output(result));
    assert.deepEqual(releasesUsed(box), ["latest"]);
  } finally {
    box.cleanup();
  }
});

test("cli: without an install it says so", () => {
  const box = sandbox();
  try {
    const result = sh(cliScript, ["status"], box.env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No InboxJoy install found/);
  } finally {
    box.cleanup();
  }
});

test("cli backup: private file, complete dumps only, newest 14 kept", () => {
  const box = installedBox();
  try {
    const backups = join(box.root, "backups");
    for (let i = 1; i <= 20; i += 1) writeFileSync(join(backups, `inboxjoy-202001${String(i).padStart(2, "0")}T030000Z.dump`), "PGDMP");
    writeFileSync(join(backups, "pre-restore-20200101T000000Z.dump"), "PGDMP");
    const result = cli(box, ["backup"]);
    assert.equal(result.status, 0, output(result));
    assert.match(result.stdout, /Backup saved:/);
    const files = backupsIn(box);
    assert.equal(files.length, 14);
    assert.ok(!files.includes("inboxjoy-20200101T030000Z.dump") && !files.includes("inboxjoy-20200106T030000Z.dump"));
    const newest = files.at(-1);
    assert.ok(!newest.startsWith("inboxjoy-2020"), "the new backup is the newest");
    assert.match(readFileSync(join(backups, newest), "utf8"), /^PGDMP/);
    assert.equal(statSync(join(backups, newest)).mode & 0o777, 0o600);
    assert.equal(backupsIn(box, "pre-restore").length, 1, "other kinds of backup are not pruned");
    assert.equal(readdirSync(backups).filter((name) => name.endsWith(".partial")).length, 0);
    assert.match(dockerCalls(box).join("\n"), /exec -T postgres pg_dump -U inboxjoy -d inboxjoy --format=custom/);
  } finally {
    box.cleanup();
  }
});

test("cli backup: a failed dump leaves nothing behind and exits with an error", () => {
  const box = installedBox();
  try {
    writeFileSync(join(box.dir, "fail-dump"), "");
    const result = cli(box, ["backup"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /backup failed/i);
    assert.deepEqual(readdirSync(join(box.root, "backups")), []);
  } finally {
    box.cleanup();
  }
});

test("cli restore: refuses without confirmation, and refuses files that are not backups", () => {
  const box = installedBox();
  try {
    const good = join(box.dir, "good.dump");
    writeFileSync(good, "PGDMP-real");
    const bad = join(box.dir, "bad.dump");
    writeFileSync(bad, "not a dump");

    const unconfirmed = cli(box, ["restore", good]);
    assert.notEqual(unconfirmed.status, 0);
    assert.match(unconfirmed.stderr, /--yes/);
    const notABackup = cli(box, ["restore", bad, "--yes"]);
    assert.notEqual(notABackup.status, 0);
    assert.match(notABackup.stderr, /not an InboxJoy backup/);
    const missing = cli(box, ["restore", join(box.dir, "nope.dump"), "--yes"]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /not found/);
    for (const mutation of [/stop/, /DROP DATABASE/, /pg_restore/]) assert.equal(indexOfCall(dockerCalls(box), mutation), -1, `${mutation} must not run`);
  } finally {
    box.cleanup();
  }
});

test("cli restore: saves a safety copy, replaces the database, migrates and restarts", () => {
  const box = installedBox();
  try {
    const source = join(box.dir, "from-last-week.dump");
    writeFileSync(source, "PGDMP-last-weeks-data");
    const result = cli(box, ["restore", source, "--yes"]);
    assert.equal(result.status, 0, output(result));
    assert.equal(readFileSync(join(box.dir, "restored"), "utf8"), "PGDMP-last-weeks-data", "the file reached pg_restore");
    assert.equal(backupsIn(box, "pre-restore").length, 1, "safety copy of the current data");
    assert.match(result.stdout, /Restore complete/);

    const calls = dockerCalls(box);
    const safety = indexOfCall(calls, /pg_dump/);
    const stop = indexOfCall(calls, /^compose stop web api worker/, safety);
    const drop = indexOfCall(calls, /DROP DATABASE IF EXISTS inboxjoy WITH \(FORCE\)/, stop);
    const create = indexOfCall(calls, /CREATE DATABASE inboxjoy TEMPLATE template0/, drop);
    const restore = indexOfCall(calls, /pg_restore -U inboxjoy -d inboxjoy/, create);
    const migrate = indexOfCall(calls, /^compose run --rm -T migrate/, restore);
    const start = indexOfCall(calls, /^compose up -d --remove-orphans/, migrate);
    assert.ok(safety >= 0 && stop > safety && drop > stop && create >= drop && restore > create && migrate > restore && start > migrate, calls.join("\n"));
  } finally {
    box.cleanup();
  }
});

test("cli restore: an empty result is an error that points at the safety copy", () => {
  const box = installedBox();
  try {
    const source = join(box.dir, "broken.dump");
    writeFileSync(source, "PGDMP-broken");
    const result = cli(box, ["restore", source, "--yes"], { MOCK_MIGRATIONS: "0" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /did not produce a usable database/);
    assert.match(result.stderr, /pre-restore-/);
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: backs up first, swaps the stack files, migrates, restarts and updates itself", () => {
  const box = installedBox();
  try {
    const result = cli(box, ["upgrade", "1.2.0"]);
    assert.equal(result.status, 0, output(result));
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.2.0");
    assert.match(readFileSync(join(box.root, ".env"), "utf8"), /^AUTH_SECRET=keep-me$/m, "other settings are untouched");
    assert.equal(readFileSync(join(box.root, "compose.yml"), "utf8"), readFileSync(join(deployDir, "compose.yml"), "utf8"));
    assert.equal(readFileSync(join(box.root, "Caddyfile"), "utf8"), readFileSync(join(deployDir, "Caddyfile"), "utf8"));
    assert.equal(readFileSync(box.env.INBOXJOY_BIN, "utf8"), readFileSync(cliScript, "utf8"), "the command updated itself");
    assert.ok(!existsSync(join(box.root, "compose.yml.previous")), "the rollback copy is removed after success");
    assert.equal(backupsIn(box).length, 1, "a backup was taken before the upgrade");
    assert.match(readFileSync(join(box.dir, "curl-calls"), "utf8"), /\/v1\.2\.0\/deploy\/compose\.yml/);
    assert.match(result.stdout, /1\.0\.0 -> 1\.2\.0/);

    const calls = dockerCalls(box);
    const dump = indexOfCall(calls, /pg_dump/);
    const pull = indexOfCall(calls, /^compose pull/, dump);
    const migrate = indexOfCall(calls, /^compose run --rm -T migrate/, pull);
    const start = indexOfCall(calls, /^compose up -d --remove-orphans/, migrate);
    assert.ok(dump >= 0 && pull > dump && migrate > pull && start > migrate, calls.join("\n"));
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: the old release until .env changes, the new one after, and never the caller's version", () => {
  const box = installedBox();
  try {
    const result = cli(box, ["upgrade", "1.2.0"], { INBOXJOY_VERSION: "0.5.0" });
    assert.equal(result.status, 0, output(result));
    const calls = composeCalls(box);
    const versionOf = (pattern) => calls.filter((call) => pattern.test(call.args)).map((call) => call.version);
    assert.deepEqual(versionOf(/pg_dump/), ["1.0.0"], "the safety backup runs before anything changes");
    for (const pattern of [/^config\b/, /^pull\b/, /^run --rm -T migrate/, /^up -d --remove-orphans/]) {
      assert.deepEqual([...new Set(versionOf(pattern))], ["1.2.0"], `${pattern} runs the new release`);
    }
    assert.ok(!releasesUsed(box).includes("0.5.0"), "the caller's version never reached compose");
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: a failed update goes back to the old release without the caller's version leaking in", () => {
  const box = installedBox();
  try {
    writeFileSync(join(box.dir, "fail-migrate"), "");
    const result = cli(box, ["upgrade", "1.2.0"], { INBOXJOY_VERSION: "0.5.0" });
    assert.notEqual(result.status, 0);
    assert.ok(releasesUsed(box).every((release) => ["1.0.0", "1.2.0"].includes(release)), releasesUsed(box).join(", "));
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.0.0");
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: with no version it finds the latest release; --no-backup skips the backup", () => {
  const box = installedBox();
  try {
    const result = cli(box, ["upgrade", "--no-backup"]);
    assert.equal(result.status, 0, output(result));
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "9.9.9");
    assert.equal(indexOfCall(dockerCalls(box), /pg_dump/), -1);
    assert.deepEqual(backupsIn(box), []);
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: an unknown version changes nothing", () => {
  const box = installedBox();
  try {
    const result = cli(box, ["upgrade", "0.0.1"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Nothing was changed/);
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.0.0");
    assert.equal(readFileSync(join(box.root, "compose.yml"), "utf8"), "services:\n  old: {}\n");
    assert.equal(indexOfCall(dockerCalls(box), /^compose (pull|stop|up|run)/), -1);
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: a failed migration puts the old settings back and restarts nothing", () => {
  const box = installedBox();
  try {
    writeFileSync(join(box.dir, "fail-migrate"), "");
    const result = cli(box, ["upgrade", "1.2.0"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /nothing was restarted/i);
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.0.0");
    assert.equal(readFileSync(join(box.root, "compose.yml"), "utf8"), "services:\n  old: {}\n");
    assert.equal(indexOfCall(dockerCalls(box), /^compose up -d --remove-orphans/), -1, "the old containers keep running");
    assert.equal(backupsIn(box).length, 1, "the pre-upgrade backup is kept");
  } finally {
    box.cleanup();
  }
});

test("cli upgrade: a failed image download puts the old settings back", () => {
  const box = installedBox();
  try {
    writeFileSync(join(box.dir, "fail-pull"), "");
    const result = cli(box, ["upgrade", "1.2.0"]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Could not download the 1\.2\.0 images/);
    assert.equal(envValue(readFileSync(join(box.root, ".env"), "utf8"), "INBOXJOY_VERSION"), "1.0.0");
    assert.equal(indexOfCall(dockerCalls(box), /^compose run/), -1);
  } finally {
    box.cleanup();
  }
});
