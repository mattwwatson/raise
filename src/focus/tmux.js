/**
 * tmux resolution.
 *
 * A tmux pane is not a window anyone can focus. It lives inside some terminal
 * tab, and which tab that is can change at any time - the session can be
 * detached and reattached somewhere else entirely.
 *
 * So we never store the host terminal for a tmux session. We resolve it at
 * focus time: pane -> tmux session -> attached client -> that client's tty,
 * which is exactly the tty the terminal adapters match on.
 *
 * Every exec here is awaited: focusing is reachable from an HTTP handler, and
 * the server must never run a child process synchronously. See execAsync in
 * ../exec.js for why.
 */

/**
 * A custom tmux socket must be honoured or we would query the wrong server.
 * $TMUX is "<socket path>,<pid>,<session index>".
 */
export function socketArgs(tmuxEnv) {
  if (!tmuxEnv) return [];
  const socketPath = String(tmuxEnv).split(',')[0];
  if (!socketPath) return [];
  return ['-S', socketPath];
}

export function tmuxCommand(tmuxEnv, args) {
  return ['tmux', [...socketArgs(tmuxEnv), ...args]];
}

/** @returns {Promise<string|null>} the tmux session name owning this pane */
export async function sessionForPane(exec, { pane, tmuxEnv }) {
  const [cmd, args] = tmuxCommand(tmuxEnv, ['display-message', '-p', '-t', pane, '#{session_name}']);
  try {
    return (await exec(cmd, args, { timeoutMs: 5000 })) || null;
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<string[]>} ttys of every client attached to the session.
 *   Empty means the session is detached and there is no window to bring forward.
 */
export async function clientTtysForSession(exec, { session, tmuxEnv }) {
  const [cmd, args] = tmuxCommand(tmuxEnv, ['list-clients', '-t', session, '-F', '#{client_tty}']);
  try {
    const out = await exec(cmd, args, { timeoutMs: 5000 });
    return out ? out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * Bring the pane to the front inside its own tmux session.
 *
 * Done before focusing the terminal so that when the window comes forward the
 * right pane is already showing.
 */
export async function selectPane(exec, { pane, tmuxEnv }) {
  const [cmd, windowArgs] = tmuxCommand(tmuxEnv, ['select-window', '-t', pane]);
  const [, paneArgs] = tmuxCommand(tmuxEnv, ['select-pane', '-t', pane]);
  try {
    await exec(cmd, windowArgs, { timeoutMs: 5000 });
    await exec(cmd, paneArgs, { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve everything needed to focus a tmux-hosted session.
 *
 * @returns {Promise<{ok: boolean, session: string|null, tty: string|null, reason?: string, hint?: string}>}
 */
export async function resolveTmuxTarget(exec, { pane, tmuxEnv }) {
  const session = await sessionForPane(exec, { pane, tmuxEnv });
  if (!session) {
    return {
      ok: false,
      session: null,
      tty: null,
      reason: 'pane-gone',
      hint: 'That tmux pane no longer exists.',
    };
  }
  const ttys = await clientTtysForSession(exec, { session, tmuxEnv });
  if (ttys.length === 0) {
    return {
      ok: false,
      session,
      tty: null,
      reason: 'detached',
      hint: `tmux attach -t ${session}`,
    };
  }
  return { ok: true, session, tty: ttys[0] };
}
