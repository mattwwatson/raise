#!/usr/bin/env node
/**
 * Raise - the no-mistakes monitor command line.
 *
 * `raise serve` is the whole product; everything else exists to get you there
 * or to explain why you are not there yet.
 */

import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { createMonitorServer } from '../src/server.js';
import {
  mergeHooks,
  removeHooks,
  readSettings,
  writeSettings,
  hookCommand,
  hookInstallState,
} from '../src/hooks.js';
import { mergeExtension, removeExtension, EXTENSION_MARKER } from '../src/pi-extension.js';
import { NoMistakesState } from '../src/nm-state.js';
import { SessionRegistry } from '../src/registry.js';
import { TranscriptReader } from '../src/transcript-reader.js';
import { GitBranch } from '../src/git-branch.js';
import { LavishState } from '../src/lavish.js';
import { ForgeState } from '../src/forge.js';
import { readForgeConfig } from '../src/forge-config.js';
import { PollWatch } from '../src/poll-watch.js';
import { FirstmateWatch } from '../src/firstmate.js';
import { focusSession } from '../src/focus/index.js';
import { ALL_TERMINALS } from '../src/focus/terminals.js';
import { exec, execAsync, tryExec, tryExecAsync } from '../src/exec.js';
import {
  monitorHome,
  sessionsDir,
  statePath,
  serverInfoPath,
  DEFAULT_PORT,
  defaultPort,
  portFromFlag,
  ensureDirs,
  piSettingsPath,
  forgeConfigPath,
} from '../src/config.js';
import { buildRows } from '../src/dashboard.js';
import { RunOwners } from '../src/run-owner.js';
import { parseArgv } from '../src/cli-args.js';
import { probeHealth } from '../src/health.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK_SCRIPT = resolve(HERE, '..', 'hooks', 'raise-hook.js');
const PI_EXTENSION = resolve(HERE, '..', 'hooks', 'raise-pi-extension.js');
const DEFAULT_SETTINGS = join(homedir(), '.claude', 'settings.json');

const bold = (s) => `[1m${s}[0m`;
const dim = (s) => `[2m${s}[0m`;
const green = (s) => `[32m${s}[0m`;
const red = (s) => `[31m${s}[0m`;
const yellow = (s) => `[33m${s}[0m`;

/**
 * What `serve` says it is reading pipeline state from.
 *
 * `absent` is not a fallback and must not read like one - no-mistakes is
 * optional, and a machine without it is a supported setup rather than a
 * half-working one.
 */
const SOURCE_LABELS = {
  sqlite: 'no-mistakes database',
  cli: 'per-repo fallback',
  absent: 'agent sessions only - no-mistakes is not installed',
};

/**
 * How each `doctor` check state is marked. Padded to a common width so the
 * names line up; a state with no entry here is a failure, which is the one
 * default a diagnostic tool may safely have.
 */
const CHECK_MARKS = {
  ok: green('ok  '),
  warn: yellow('warn'),
  off: dim('--  '),
};

/**
 * Help must never fail.
 *
 * A malformed RAISE_PORT is a real error for `serve`, which reports it properly
 * - but `raise --help` is often exactly how you go looking for what that
 * variable is supposed to contain, and throwing out of usage() leaves you with
 * a stack trace instead of the answer.
 */
function describedDefaultPort() {
  try {
    return String(defaultPort());
  } catch {
    return `${DEFAULT_PORT}; RAISE_PORT is currently set to something that is not a port`;
  }
}

/**
 * The port `serve` would most likely use, for diagnostics that must not throw.
 *
 * `doctor` reports on a bad RAISE_PORT by way of the port it then fails to
 * find a server on; refusing to run at all would be a worse diagnosis.
 */
function probablePort() {
  try {
    return defaultPort();
  } catch {
    return DEFAULT_PORT;
  }
}

function usage() {
  return `${bold('Raise')} - watch every no-mistakes run and agent session on this machine

${bold('Usage')}
  raise serve              start the monitor and print the dashboard URL
  raise open               print (and open) the dashboard URL
  raise status             one-shot text summary, no server needed
  raise focus <session>    bring a session's window to the front
  raise install-hooks      add the Claude Code hooks to settings.json
  raise uninstall-hooks    remove them again
  raise install-pi         add the pi extension to pi's settings.json
  raise uninstall-pi       remove it again
  raise doctor             check the setup and explain anything missing

${bold('Options')}
  --port <n>               listen on a different port (default ${describedDefaultPort()})
  --settings <path>        settings file for install/uninstall (defaults to the
                           agent's own: ~/.claude/settings.json, ~/.pi/agent/settings.json)
  --dry-run                show what would change, write nothing
  --yes                    do not ask for confirmation
`;
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

// ------------------------------------------------------------------ commands

async function cmdServe(flags) {
  ensureDirs();
  let port;
  try {
    port = flags.port === undefined ? defaultPort() : portFromFlag(flags.port);
  } catch (err) {
    console.error(red(err.message));
    process.exitCode = 1;
    return;
  }
  const monitor = createMonitorServer({ port });
  try {
    await monitor.start();
  } catch (err) {
    if (err?.code !== 'EADDRINUSE' && err?.code !== 'EACCES') {
      await monitor.stop();
      throw err;
    }
    const lines =
      err.code === 'EACCES'
        ? [
            red(`Port ${port} needs root.`),
            `  Pick one above 1024, ${bold('for example --port 7718')}.`,
          ]
        : await explainBusyPort(port);
    for (const line of lines) console.error(line);
    // Nothing was bound, so no server.json of ours exists to remove; this is
    // only here to close the database handle the monitor opened on the way up.
    await monitor.stop();
    process.exitCode = 1;
    return;
  }

  console.log(`${bold('Raise')} is watching.`);
  console.log(`  Dashboard  ${green(monitor.url())}`);
  console.log(`  Source     ${SOURCE_LABELS[monitor.probe.mode] ?? SOURCE_LABELS.cli}`);
  if (monitor.probe.warning) console.log(`  ${yellow('Note')}       ${monitor.probe.warning}`);

  const settings = readSettingsQuietly(DEFAULT_SETTINGS);
  const hooks = hookInstallState(settings);
  if (hooks.state === 'missing') {
    console.log(
      `\n  ${yellow('Hooks are not installed.')} Pipeline state will still show, but Raise cannot\n` +
        '  tell when Claude is waiting for you, and cannot focus windows.\n' +
        `  Run ${bold('raise install-hooks')}, then restart your Claude sessions.`,
    );
  } else if (hooks.state === 'partial') {
    // Everything already installed keeps working, so this says what is missing
    // rather than repeating the message above - claiming Raise is blind while
    // SessionStart and Notification are both in place would be a lie.
    console.log(
      `\n  ${yellow('Hooks are out of date.')} What is installed still works; Raise is missing\n` +
        `  ${hooks.missing.join(', ')}.\n` +
        `  Run ${bold('raise install-hooks')}, then restart your Claude sessions.`,
    );
  }
  console.log(dim('\n  Ctrl-C to stop.'));

  const shutdown = async () => {
    await monitor.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function readServerInfo() {
  try {
    return JSON.parse(readFileSync(serverInfoPath(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Turn a busy port into the one sentence that tells you what to do about it.
 *
 * The three cases need three different answers, and guessing wrong is
 * expensive: telling someone to `kill` a pid that belongs to an unrelated
 * program is worse than saying nothing. So the port is asked directly rather
 * than inferred from server.json, which is silent about both a server that was
 * killed rather than stopped and a server started under another RAISE_HOME -
 * the second of which is the usual cause of this message.
 *
 * @param {number} port
 * @returns {Promise<string[]>} lines to print, already coloured
 */
async function explainBusyPort(port) {
  const live = await probeHealth(port);
  if (!live) {
    return [
      red(`Port ${port} is in use, and whatever is listening is not Raise.`),
      `  Find it   ${bold(`lsof -nP -iTCP:${port} -sTCP:LISTEN`)}`,
      `  Or run    ${bold('raise serve --port <n>')}`,
    ];
  }
  const info = readServerInfo();
  if (info?.port === port && info?.pid === live.pid) {
    return [
      `${bold('Raise')} is already running on port ${port} (pid ${live.pid}).`,
      `  Open it   ${bold('raise open')}`,
    ];
  }
  return [
    red(`Port ${port} is held by another Raise (pid ${live.pid}) that this installation has`),
    red('no record of - most likely a leftover started with a different RAISE_HOME.'),
    `  Stop it   ${bold(`kill ${live.pid}`)}`,
    `  Or run    ${bold('raise serve --port <n>')}`,
  ];
}

async function cmdOpen() {
  const info = readServerInfo();
  if (!info) {
    console.error(`raise is not running. Start it with ${bold('raise serve')}.`);
    process.exitCode = 1;
    return;
  }
  // The record outlives a server that was killed rather than stopped. Opening a
  // browser tab onto a dead port is a worse answer than admitting it is dead.
  if (!(await probeHealth(info.port))) {
    console.error(
      `Recorded on port ${info.port} (pid ${info.pid}), but nothing is answering - the server has stopped.`,
    );
    console.error(`Start it with ${bold('raise serve')}.`);
    process.exitCode = 1;
    return;
  }
  const url = `http://127.0.0.1:${info.port}/?t=${info.token}`;
  console.log(url);
  if (process.platform === 'darwin') tryExec(exec, 'open', [url]);
}

async function cmdStatus() {
  const registry = new SessionRegistry({ dir: sessionsDir() });
  const sessions = registry.list();
  const nmState = new NoMistakesState({ dbPath: statePath(), exec });
  nmState.probe();
  const candidateDirs = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
  // One shot and then gone, so this is the one caller that can afford to wait
  // for the degraded path rather than reporting an empty cache.
  const { runs, pullRequests, warning } = nmState.read({ candidateDirs, blocking: true });

  const transcripts = new TranscriptReader();
  const gitBranches = new GitBranch();
  // The branch, and the checkout a worktree session's run is registered against
  // - Treehouse puts every session in one, and nothing else can place its
  // pipeline. One `.git` read answers both, and both are needed: the link says
  // which checkout, the branch says which of that checkout's runs.
  const branches = new Map();
  const mainCheckouts = new Map();
  for (const s of sessions) {
    const { branch, mainCheckout } = gitBranches.checkoutFor(s.cwd);
    branches.set(s.sessionId, branch);
    mainCheckouts.set(s.sessionId, mainCheckout);
  }
  const agentPids = new Set(sessions.map((s) => s.host?.pid).filter(Boolean));
  const polls = new PollWatch({ execAsync });
  await polls.load(agentPids);
  // One shot, so the pane table is read up front and waited for rather than
  // answered from a cache that is empty on the only tick there is.
  const firstmate = new FirstmateWatch({ execAsync });
  await firstmate.load(sessions);
  const spawnedBy = new Map(sessions.map((s) => [s.sessionId, firstmate.spawnedBy(s)]));
  const summaries = new Map(
    sessions.map((s) => {
      const read = transcripts.read(s.transcriptPath, branches.get(s.sessionId));
      const polledFile = polls.fileFor(s.host?.pid, agentPids);
      return [s.sessionId, polledFile ? { ...read, lavishFile: polledFile } : read];
    }),
  );
  const pipelines = new Set(
    sessions.filter((s) => polls.pipelineFor(s.host?.pid, agentPids)).map((s) => s.sessionId),
  );
  // One shot, so ownership is only what is running this instant - a run parked
  // between `axi run` and `axi respond` has nothing to observe, and prints as a
  // row of its own saying it could not be placed. The server, which polls,
  // catches `axi run` as it starts and remembers instead.
  const runOwners = new RunOwners();
  runOwners.observeFrom(
    sessions,
    runs,
    (s) => polls.ownsRunFor(s.host?.pid, agentPids),
    mainCheckouts,
    branches,
  );

  // Asking Lavish costs a second or two, so it is only worth it when something
  // is actually waiting on a review.
  const reviewUrls = new Map();
  const awaitingReview = [...summaries].filter(([, summary]) => summary.lavishFile);
  if (awaitingReview.length > 0) {
    const lavish = new LavishState({ execAsync });
    await lavish.load();
    for (const [sessionId, summary] of awaitingReview) {
      reviewUrls.set(sessionId, lavish.urlFor(summary.lavishFile));
    }
  }

  // Reuse the dashboard projection so the CLI and the page can never disagree.
  const projection = {
    sessions,
    runs,
    summaries,
    reviewUrls,
    branches,
    mainCheckouts,
    pullRequests,
    pipelines,
    runOwners: runOwners.owners,
    spawnedBy,
  };
  let rows = buildRows(projection);

  // The forge knows which pull requests are still open, and the rows are what
  // say which ones are worth asking about - so the projection is built once to
  // find them, and again once the answers are in. Two passes of a pure function
  // against one network round trip, and it keeps the CLI agreeing with the page
  // about a pull request rather than being the one renderer that quietly does
  // not check. Awaiting is right here and wrong in the server: this is one shot,
  // so there is no later tick for an answer to arrive on.
  const forge = new ForgeState({ execAsync, fetch, config: readForgeConfig() });
  if (forge.enabled) {
    const urls = rows.map((row) => row.pr?.url).filter(Boolean);
    if (urls.length > 0) {
      await forge.load(urls);
      rows = buildRows({ ...projection, forgeStates: forge.readings });
    }
  }

  if (warning) console.log(`${yellow('Note')} ${warning}\n`);
  if (rows.length === 0) {
    console.log('Nothing running.');
    nmState.close();
    return;
  }
  for (const row of rows) {
    const colour =
      row.attention === 'blocked' || row.attention === 'review'
        ? red
        : row.attention === 'parked'
          ? yellow
          : dim;
    // Same place as on the page - between the repo and the branch - so the two
    // tell one story about which session is which. The separator is the one
    // thing the page does without: there the name is prose beside a monospace
    // branch and needs no help, while here both are dimmed alike and would run
    // together into one string. It is only ever between the two, so a row
    // missing either does not grow a dangling dot.
    const identity = [row.sessionName, row.branch].filter(Boolean).join(' · ');
    const named = identity ? ` ${dim(identity)}` : '';
    // Where the page puts its chip, in the one place a reader is already
    // looking for what this row is. The page can afford to say it twice, in the
    // chip and in a section heading; here it is said once and then explained.
    const unplaceable = row.attributable === false ? ` ${dim('unattributed')}` : '';
    // Who started this window, on the rows where something declared it. Named
    // only when it is worth naming, exactly as on the page: a session nobody in
    // particular started says nothing rather than saying so.
    const spawner = row.spawnedBy ? ` ${dim(row.spawnedBy)}` : '';
    // Why this row reads Idle rather than Waiting for you. Said here for the
    // same reason the page says it: the two must never disagree about a session,
    // and a signal suppressed without a word is the quiet staleness this tool is
    // built against.
    const dismissed = row.dismissed ? ` ${dim('dismissed')}` : '';
    console.log(
      `${colour(row.attentionLabel.padEnd(26))} ${bold(row.title)}${named}${spawner}${dismissed}${unplaceable}`,
    );
    if (row.message) console.log(`  ${dim(row.message)}`);
    // Always, pipeline or no pipeline. This used to be dropped whenever a step
    // existed, so the moment no-mistakes started, what you had been talking to
    // the session about vanished off the row. They are concurrent, and the
    // pipeline has a line of its own below.
    if (row.summary) console.log(`  ${dim(row.summary)}`);
    // Why an unplaceable run is here at all, in the same words as the page.
    if (row.attributable === false) {
      const guess = row.candidateSessions
        ? ` - probably one of your ${row.candidateSessions} on this repo`
        : '';
      console.log(`  ${dim(`Not traceable to a session${guess}`)}`);
    }
    if (row.activity && row.attention !== 'idle') {
      console.log(`  ${dim(row.activity)}`);
    }
    // What no-mistakes is doing, on the session's own row rather than a row of
    // its own - and present because the *run* is, never because it is saying
    // something. `what` covers all three shapes the pipeline takes, the folded
    // agent's tool included, so this is the only pipeline line the CLI needs.
    if (row.pipeline) {
      const findings = row.run?.step?.findings
        ? ` - ${row.run.step.findings} finding(s)`
        : '';
      const what = row.pipeline.what ? ` · ${row.pipeline.what}` : '';
      console.log(`  ${dim(`no-mistakes  ${row.pipeline.step}${findings}${what}`)}`);
    }
    if (row.reviewUrl) console.log(`  ${row.reviewUrl}`);
    // The state word only while the reading is current - the run still going
    // *and* the state observed recently. The link is printed either way.
    if (row.pr) {
      const label = row.pr.number ? `PR #${row.pr.number}` : 'PR';
      const state = row.pr.current && row.pr.state ? ` ${row.pr.state}` : '';
      console.log(`  ${dim(`${label}${state}`)} ${row.pr.url}`);
    }
  }
  nmState.close();
}

async function cmdFocus(positional) {
  const sessionId = positional[0];
  if (!sessionId) {
    console.error('Usage: raise focus <session-id>');
    process.exitCode = 1;
    return;
  }
  const registry = new SessionRegistry({ dir: sessionsDir() });
  const record = registry.get(sessionId);
  if (!record) {
    console.error(`No session ${sessionId}. Run ${bold('raise status')} to list them.`);
    process.exitCode = 1;
    return;
  }
  const result = await focusSession(record, { exec: execAsync });
  if (result.ok) {
    console.log(result.note || `Focused via ${result.adapter}.`);
  } else {
    console.error(result.reason || 'Could not focus that session.');
    if (result.hint) console.error(`  Try: ${bold(result.hint)}`);
    process.exitCode = 1;
  }
}

function readSettingsQuietly(path) {
  try {
    return readSettings(path);
  } catch {
    return {};
  }
}

async function cmdInstallHooks(flags) {
  const settingsPath = flags.settings || DEFAULT_SETTINGS;
  const command = hookCommand(process.execPath, HOOK_SCRIPT);
  let existing;
  try {
    existing = readSettings(settingsPath);
  } catch (err) {
    console.error(red(err.message));
    process.exitCode = 1;
    return;
  }
  const { settings, changes } = mergeHooks(existing, command);

  if (changes.length === 0) {
    console.log(`${green('Already installed')} - hooks in ${settingsPath} are up to date.`);
    return;
  }

  console.log(`${bold('Changes to')} ${settingsPath}`);
  for (const change of changes) console.log(`  ${change}`);
  console.log(`\n${bold('Hook command')}\n  ${command}\n`);

  if (flags['dry-run']) {
    console.log(dim('Dry run; nothing written.'));
    return;
  }
  if (!flags.yes && !(await confirm('Write these changes?'))) {
    console.log('Nothing written.');
    return;
  }
  const backupPath = writeSettings(settingsPath, settings);
  console.log(green(`Installed. ${backupPath ? `Backup at ${backupPath}` : ''}`));
  console.log(
    dim('Restart any Claude sessions you already have open - hooks are read at session start.'),
  );
}

async function cmdUninstallHooks(flags) {
  const settingsPath = flags.settings || DEFAULT_SETTINGS;
  const existing = readSettings(settingsPath);
  const { settings, changes } = removeHooks(existing);
  if (changes.length === 0) {
    console.log('No Raise hooks found.');
    return;
  }
  if (flags['dry-run']) {
    console.log(changes.join('\n'));
    return;
  }
  if (!flags.yes && !(await confirm(`Remove ${changes.length} hook entries from ${settingsPath}?`))) {
    console.log('Nothing written.');
    return;
  }
  writeSettings(settingsPath, settings);
  console.log(green('Removed.'));
}

async function cmdInstallPiExtension(flags) {
  const settingsPath = flags.settings || piSettingsPath();
  let existing;
  try {
    existing = readSettings(settingsPath);
  } catch (err) {
    console.error(red(err.message));
    process.exitCode = 1;
    return;
  }
  const { settings, changes } = mergeExtension(existing, PI_EXTENSION);

  if (changes.length === 0) {
    console.log(`${green('Already installed')} - ${settingsPath} is up to date.`);
    return;
  }

  console.log(`${bold('Changes to')} ${settingsPath}`);
  for (const change of changes) console.log(`  ${change}`);
  console.log(`\n${bold('Extension')}\n  ${PI_EXTENSION}\n`);

  if (flags['dry-run']) {
    console.log(dim('Dry run; nothing written.'));
    return;
  }
  if (!flags.yes && !(await confirm('Write these changes?'))) {
    console.log('Nothing written.');
    return;
  }
  const backupPath = writeSettings(settingsPath, settings);
  console.log(green(`Installed. ${backupPath ? `Backup at ${backupPath}` : ''}`));
  console.log(
    dim('Restart any pi sessions you already have open - extensions are loaded at startup.'),
  );
}

async function cmdUninstallPiExtension(flags) {
  const settingsPath = flags.settings || piSettingsPath();
  const existing = readSettings(settingsPath);
  const { settings, changes } = removeExtension(existing);
  if (changes.length === 0) {
    console.log('No Raise extension found.');
    return;
  }
  if (flags['dry-run']) {
    console.log(changes.join('\n'));
    return;
  }
  if (!flags.yes && !(await confirm(`Remove the Raise extension from ${settingsPath}?`))) {
    console.log('Nothing written.');
    return;
  }
  writeSettings(settingsPath, settings);
  console.log(green('Removed.'));
}

async function cmdDoctor() {
  const checks = [];
  const ok = (name, detail) => checks.push({ state: 'ok', name, detail });
  const warn = (name, detail) => checks.push({ state: 'warn', name, detail });
  const bad = (name, detail) => checks.push({ state: 'bad', name, detail });
  // Neither good nor bad: an optional integration that is simply not here, and
  // nothing to act on. Distinct from `warn`, which always has a next step.
  const off = (name, detail) => checks.push({ state: 'off', name, detail });

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 5)) {
    ok('Node', `v${process.versions.node}`);
  } else {
    bad('Node', `v${process.versions.node} - Raise needs 22.5 or newer for the built-in SQLite support`);
  }

  // no-mistakes is optional, so its absence is reported rather than failed. A
  // doctor that says "fail" over something the user never chose to install is
  // one that gets ignored the next time it says it about something real.
  const dbPath = statePath();
  const state = new NoMistakesState({ dbPath, exec });
  const probe = state.probe();
  if (probe.mode === 'absent') {
    off('no-mistakes', `not installed - no pipeline rows; everything else works (looked in ${dbPath})`);
  } else if (probe.mode === 'sqlite') {
    const { runs } = state.read();
    ok('no-mistakes database', `readable, ${runs.length} run(s) in the current window`);
  } else {
    warn('no-mistakes database', probe.warning);
  }
  state.close();

  // Optional in the same way, and worth naming: without it nothing can put a
  // session into "waiting on your review", because that state is detected by
  // watching for a live `lavish-axi poll` and by nothing else.
  if (await tryExecAsync(execAsync, 'lavish-axi', ['--help'])) {
    ok('lavish-axi', 'available');
  } else {
    off('lavish-axi', 'not installed - review gates will not be detected');
  }

  // The only outbound request Raise makes, so its default is off and its default
  // is silent - `off` rather than `warn`, exactly like no-mistakes and Lavish. A
  // `problem` is different: it is only ever set when somebody has evidently
  // tried to configure this and it is not working, and the whole point of
  // refusing an unsafe file mode is that they find out here rather than by
  // noticing that nothing happens.
  const forgeConfig = readForgeConfig();
  if (forgeConfig.problem) {
    warn('Pull request state', forgeConfig.problem);
  } else if (!forgeConfig.enabled) {
    off(
      'Pull request state',
      `not enabled - pull request state comes from no-mistakes only (see ${forgeConfigPath()})`,
    );
  } else if (forgeConfig.bitbucket) {
    ok('Pull request state', 'enabled - GitHub through gh, Bitbucket through its API');
  } else {
    ok('Pull request state', 'enabled for GitHub through gh; no Bitbucket credential configured');
  }

  const settings = readSettingsQuietly(DEFAULT_SETTINGS);
  const hooks = hookInstallState(settings);
  if (hooks.state === 'installed') {
    ok('Claude Code hooks', `installed in ${DEFAULT_SETTINGS}`);
  } else if (hooks.state === 'partial') {
    warn(
      'Claude Code hooks',
      `out of date - missing ${hooks.missing.join(', ')}. Run ${bold('raise install-hooks')} ` +
        'and restart your Claude sessions to pick them up',
    );
  } else {
    warn('Claude Code hooks', `not installed - run ${bold('raise install-hooks')}`);
  }

  // Only reported when pi is actually installed. Telling somebody who does not
  // use pi that a pi extension is missing is noise dressed as a problem, and a
  // doctor that cries wolf gets skimmed.
  const piSettings = piSettingsPath();
  if (existsSync(piSettings)) {
    const installed = (readSettingsQuietly(piSettings).extensions || []).some(
      (entry) => typeof entry === 'string' && entry.includes(EXTENSION_MARKER),
    );
    if (installed) {
      ok('pi extension', `installed in ${piSettings}`);
    } else {
      warn('pi extension', `not installed - run ${bold('raise install-pi')}`);
    }
  }

  const sessions = new SessionRegistry({ dir: sessionsDir() }).list();
  if (sessions.length > 0) {
    const focusable = sessions.filter((s) => s.host?.tmux_pane || s.host?.iterm_session_id || s.host?.tty);
    ok('Sessions', `${sessions.length} registered, ${focusable.length} focusable`);
  } else {
    warn('Sessions', 'none registered yet - start a Claude session after installing the hooks');
  }

  if (await tryExecAsync(execAsync, 'tmux', ['-V'])) {
    ok('tmux', 'available');
  } else {
    warn('tmux', 'not installed - only plain terminal tabs can be focused');
  }

  const available = [];
  for (const terminal of ALL_TERMINALS) {
    if (await terminal.isAvailable(execAsync)) available.push(terminal.label);
  }
  if (available.length > 0) {
    ok('Terminals', available.join(', '));
  } else if (process.platform === 'darwin') {
    warn('Terminals', 'no supported terminal running (iTerm2, Terminal.app)');
  } else {
    warn('Terminals', `focusing is macOS-only so far; on ${process.platform} Raise still monitors`);
  }

  // server.json says where the monitor was last started, which is a different
  // question from where it is now - so ask the port as well as the record.
  const info = readServerInfo();
  const probePort = info?.port ?? probablePort();
  const live = await probeHealth(probePort);
  if (info && live && live.pid === info.pid) {
    ok('Server', `running on port ${info.port} (pid ${live.pid})`);
  } else if (info && live) {
    warn(
      'Server',
      `server.json names pid ${info.pid}, but port ${info.port} is answered by pid ${live.pid} - stale record, and another Raise has the port`,
    );
  } else if (info) {
    warn(
      'Server',
      `server.json names port ${info.port} (pid ${info.pid}) but nothing is answering - stale record from a server that did not shut down cleanly`,
    );
  } else if (live) {
    warn(
      'Server',
      `port ${probePort} is held by another Raise (pid ${live.pid}) with no record here - probably a leftover; ${bold(`kill ${live.pid}`)} or use --port`,
    );
  } else {
    warn('Server', `not running - start it with ${bold('raise serve')}`);
  }

  console.log(`${bold('raise doctor')}   home: ${monitorHome()}\n`);
  for (const check of checks) {
    const mark = CHECK_MARKS[check.state] ?? red('fail');
    console.log(`  ${mark}  ${check.name.padEnd(22)} ${check.detail}`);
  }
  if (checks.some((c) => c.state === 'bad')) process.exitCode = 1;
}

// --------------------------------------------------------------------- entry

async function main() {
  const { command, flags, positional, wantsHelp } = parseArgv(process.argv.slice(2));

  if (wantsHelp) {
    console.log(usage());
    return;
  }

  switch (command) {
    case 'serve':
      await cmdServe(flags);
      break;
    case 'open':
      await cmdOpen();
      break;
    case 'status':
      await cmdStatus();
      break;
    case 'focus':
      await cmdFocus(positional);
      break;
    case 'install-hooks':
      await cmdInstallHooks(flags);
      break;
    case 'uninstall-hooks':
      await cmdUninstallHooks(flags);
      break;
    case 'install-pi':
      await cmdInstallPiExtension(flags);
      break;
    case 'uninstall-pi':
      await cmdUninstallPiExtension(flags);
      break;
    case 'doctor':
      await cmdDoctor();
      break;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(usage());
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(red(err.stack || err.message));
  process.exit(1);
});
