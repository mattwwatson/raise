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
 * Every client attached to a session, and crucially whether it is a control
 * mode client.
 *
 * A control mode client (`tmux -CC`, which is how iTerm2 hosts tmux) is not a
 * terminal anyone looks at. Its tty belongs to the tab where `tmux -CC` was
 * typed, and that tab sits idle while the real content is drawn in native
 * iTerm2 tabs the tmux client knows nothing about. Focusing its tty is the one
 * thing guaranteed to be wrong.
 *
 * @returns {Promise<{tty: string, controlMode: boolean}[]>} empty means detached
 */
export async function clientsForSession(exec, { session, tmuxEnv }) {
  const [cmd, args] = tmuxCommand(tmuxEnv, [
    'list-clients',
    '-t',
    session,
    '-F',
    '#{client_tty}\t#{client_control_mode}',
  ]);
  try {
    const out = await exec(cmd, args, { timeoutMs: 5000 });
    return parseClients(out);
  } catch {
    return [];
  }
}

/** @param {string} out tab-separated `tty<TAB>control` lines */
export function parseClients(out) {
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [tty, control] = line.split('\t');
      return { tty: (tty || '').trim(), controlMode: String(control || '').trim() === '1' };
    })
    .filter((client) => client.tty);
}

/**
 * The pane's title, which is the only handle iTerm2 gives us on a control mode
 * pane - it names each one after its tmux title, and exposes no tty for them.
 *
 * @returns {Promise<string|null>}
 */
export async function paneTitle(exec, { pane, tmuxEnv }) {
  const [cmd, args] = tmuxCommand(tmuxEnv, ['display-message', '-p', '-t', pane, '#{pane_title}']);
  try {
    return (await exec(cmd, args, { timeoutMs: 5000 })) || null;
  } catch {
    return null;
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
 * `tty` is deliberately the first *plain* client's, because that is the only
 * kind whose tty names a window you can see. When every client is in control
 * mode there is no such tty, and `controlMode` says so rather than handing back
 * the control client's and letting the caller raise the wrong tab.
 *
 * @returns {Promise<{ok: boolean, session: string|null, tty: string|null,
 *   controlMode: boolean, title: string|null, reason?: string, hint?: string}>}
 */
export async function resolveTmuxTarget(exec, { pane, tmuxEnv }) {
  const session = await sessionForPane(exec, { pane, tmuxEnv });
  if (!session) {
    return {
      ok: false,
      session: null,
      tty: null,
      controlMode: false,
      title: null,
      reason: 'pane-gone',
      hint: 'That tmux pane no longer exists.',
    };
  }
  const clients = await clientsForSession(exec, { session, tmuxEnv });
  if (clients.length === 0) {
    return {
      ok: false,
      session,
      tty: null,
      controlMode: false,
      title: null,
      reason: 'detached',
      hint: `tmux attach -t ${session}`,
    };
  }
  const plain = clients.find((client) => !client.controlMode) || null;
  const controlMode = clients.some((client) => client.controlMode);
  return {
    ok: true,
    session,
    tty: plain ? plain.tty : null,
    controlMode,
    title: controlMode ? await paneTitle(exec, { pane, tmuxEnv }) : null,
  };
}
