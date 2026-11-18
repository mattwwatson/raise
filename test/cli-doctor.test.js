/**
 * `raise doctor`'s session count, run as the real command against a scratch
 * `RAISE_HOME`.
 *
 * The count says how many sessions a click could do something for, so it has
 * to agree with the page and with `raise focus`, which both ask `planFocus`. It
 * used to apply a looser rule of its own, and counted a Herdr session with an
 * address Raise does not recognise as focusable while the page showed it as
 * `no window` and `raise focus` refused it.
 *
 * Nothing here reads a real installation, and nothing focuses anything.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { SessionRegistry } from '../src/registry.js';

const execFileAsync = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'raise.js');

test('doctor counts a Herdr session with an unrecognised address as not focusable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'raise-doctor-'));
  try {
    const raiseHome = join(dir, 'raise');
    const registry = new SessionRegistry({ dir: join(raiseHome, 'sessions') });
    const start = (sessionId, host) =>
      registry.record({ session_id: sessionId, hook_event_name: 'SessionStart', cwd: dir, host });
    start('herdr-good', { hc_terminal_id: 't8', hc_terminal_socket: '/tmp/default.sock' });
    start('herdr-bad', { hc_terminal_id: 'bogus', hc_terminal_socket: '/tmp/default.sock' });
    start('tab', { tty: '/dev/ttys001' });

    const { stdout } = await execFileAsync(process.execPath, [CLI, 'doctor'], {
      env: {
        ...process.env,
        RAISE_HOME: raiseHome,
        NM_HOME: join(dir, 'nm'),
        CLAUDE_CONFIG_DIR: join(dir, 'claude'),
        PI_CODING_AGENT_DIR: join(dir, 'pi'),
        CODEX_HOME: join(dir, 'codex'),
      },
    });
    assert.match(stdout, /3 registered, 2 focusable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
