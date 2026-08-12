/**
 * tmux resolution.
 *
 * A tmux pane is not a window anyone can focus. It lives inside some terminal
 * tab, and which tab that is can change at any time - the session can be
 * detached and reattached somewhere else entirely.
 *
 * So we never store the host terminal for a tmux session. We resolve it at
 * focus time. What that resolution cannot assume is that a pane belongs to one
 * session: `link-window` puts a single window in several sessions at once, and
 * a grouped session does the same. Asking tmux which session owns a pane gets
 * an arbitrary one of the true answers, and acting on it raises somebody else's
 * tab and switches their view. So we enumerate every session the pane lives in,
 * weigh every attached client against those, choose one, and speak to tmux in
 * that client's session by id from then on. See chooseTmuxClient.
 *
 * **Which of the true answers tmux gives varies with time, which is why the
 * symptom is intermittent.** It hands back whichever session was most recently
 * active: four panes that resolved to a parent session one afternoon resolved
 * to the per-worker viewer an hour later, with nothing changed but that. A bug
 * report saying "sometimes" is the expected shape of this one rather than a
 * sign of something else.
 *
 * **Control mode (`tmux -CC`, which is how iTerm2 hosts tmux) breaks every
 * assumption above and is matched on pane title instead of tty.** Each tmux
 * window becomes a native iTerm2 tab the tmux client knows nothing about,
 * iTerm2 reports `tty` as `missing value` for all of them, and the client's own
 * tty belongs to the idle tab where `tmux -CC` was typed - so focusing that tty,
 * which is correct for ordinary tmux, raised that one tab every single time.
 * The title is the one handle both sides share, since iTerm2 names each tab
 * after the tmux pane title. See `paneTitle` here, and `titleNeedle` in
 * ./index.js for why the leading status glyph is stripped first. On a title
 * collision Raise says so rather than raising an arbitrary window, and nothing
 * is selected inside tmux: iTerm2 does not follow tmux's selection in control
 * mode, so doing it anyway would move the user's active window for no visible
 * reason.
 *
 * **No `-t` target is ever a session name.** Names are user data - a bell
 * plugin renames sessions to `hv-sls-86-fb9d 🔔` on this machine, and
 * `-t hv-sls-7` really does prefix-match it. Targets are ids (`$204:@349`,
 * which cannot mis-split because tmux forbids `:` and `.` in a name), and the
 * one name that reaches a human - the `tmux attach` hint - goes through
 * `shellQuote`.
 *
 * Every exec here is awaited: focusing is reachable from an HTTP handler, and
 * the server must never run a child process synchronously. See execAsync in
 * ../exec.js for why.
 */

/**
 * The socket a `$TMUX` value names, which is what identifies the *server* - the
 * two fields after it are the server pid and the session index, so the same
 * server reaches us under a different `$TMUX` from every session on it. The one
 * place that splits the string, so anything keying on a server keys on the same
 * thing `-S` is given.
 *
 * @param {string|null|undefined} tmuxEnv
 * @returns {string} empty for no `$TMUX` at all, meaning the default server
 */
export function socketPath(tmuxEnv) {
  if (!tmuxEnv) return '';
  return String(tmuxEnv).split(',')[0];
}

/**
 * A custom tmux socket must be honoured or we would query the wrong server.
 * $TMUX is "<socket path>,<pid>,<session index>".
 */
export function socketArgs(tmuxEnv) {
  const path = socketPath(tmuxEnv);
  if (!path) return [];
  return ['-S', path];
}

export function tmuxCommand(tmuxEnv, args) {
  return ['tmux', [...socketArgs(tmuxEnv), ...args]];
}

/**
 * One session a pane's window belongs to. There is a row per session, not per
 * pane, because a linked window genuinely lives in all of them.
 *
 * @typedef {object} PaneSession
 * @property {string} paneId
 * @property {string} sessionId "$204" - the only unambiguous way to name a session
 * @property {string} windowId "@349"
 * @property {number} windowCount how many windows that session holds
 * @property {string} sessionName for messages only, never for a `-t` target
 */

/**
 * An attached tmux client.
 *
 * `windowId` is the window this client is *currently displaying*, which is what
 * lets us prefer a client that already shows the pane and so needs nothing
 * moved. A control mode client (`tmux -CC`, which is how iTerm2 hosts tmux) is
 * not a terminal anyone looks at: its tty belongs to the tab where `tmux -CC`
 * was typed, and that tab sits idle while the real content is drawn in native
 * iTerm2 tabs the tmux client knows nothing about.
 *
 * @typedef {object} TmuxClient
 * @property {string} tty
 * @property {boolean} controlMode
 * @property {string} sessionId
 * @property {string} windowId
 */

/**
 * A tmux session name is user data - a bell plugin renames sessions to
 * `hv-sls-86-fb9d 🔔` on this machine - and the attach hint is a command a
 * human will paste. Unquoted that is two arguments, and tmux answers it by
 * prefix-matching some other session.
 *
 * @param {string} value
 * @returns {string}
 */
export function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * @param {string|null} out tab-separated `pane<TAB>session<TAB>window<TAB>count<TAB>name`
 * @returns {PaneSession[]}
 */
export function parsePaneSessions(out) {
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      // The name is emitted last and taken as the remainder, so a tab inside a
      // session name cannot eat a field boundary.
      const [paneId, sessionId, windowId, windowCount, ...rest] = line.split('\t');
      return {
        paneId: (paneId || '').trim(),
        sessionId: (sessionId || '').trim(),
        windowId: (windowId || '').trim(),
        windowCount: Number.parseInt(windowCount, 10) || 0,
        sessionName: rest.join('\t'),
      };
    })
    .filter((row) => row.paneId && row.sessionId && row.windowId);
}

/**
 * @param {string|null} out tab-separated `tty<TAB>control<TAB>session<TAB>window` lines
 * @returns {TmuxClient[]}
 */
export function parseClients(out) {
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [tty, control, sessionId, windowId] = line.split('\t');
      return {
        tty: (tty || '').trim(),
        controlMode: String(control || '').trim() === '1',
        sessionId: (sessionId || '').trim(),
        windowId: (windowId || '').trim(),
      };
    })
    .filter((client) => client.tty && client.sessionId);
}

/**
 * Which attached client we should raise for a pane, and so which session to
 * speak to tmux in.
 *
 * A tmux window can belong to more than one session, and both answers are true
 * - only one of them has a tab in front of the user. So the clients on every
 * candidate session are ranked:
 *
 *   1. one already displaying the pane's window, because raising it moves
 *      nothing inside tmux, and moving somebody else's view is the failure this
 *      whole path exists to avoid;
 *   2. failing that, the one on the session holding fewest windows - a session
 *      holding only this window is a viewer dedicated to it, where a session
 *      holding five is somebody's working view that merely happens to be parked
 *      here.
 *
 * Two picks come out of that one ranking, not one, because they answer
 * different questions. `chosen` is the best client overall; `plain` is the best
 * non-control client and says which tty to raise and which session to select
 * in. They are the same client in every ordinary case, and collapsing them
 * would lose the fallback a control mode session with a second, ordinary
 * `tmux attach` depends on.
 *
 * `controlMode` - whether this pane might be living in a native terminal tab
 * tmux cannot see - is a property of the whole ranked set and not of `chosen`,
 * because rule 1 discriminates only *between* candidate sessions and never
 * within one. tmux has no per-client current window: `#{window_id}` in a
 * client's format context resolves to the client's *session's* current window,
 * so two clients on the same session tie on both keys and `chosen` falls out of
 * `list-clients` ordering, which is attach order. Read off `chosen`, a plain
 * `tmux attach` that attached before the iTerm2 `tmux -CC` client would suppress
 * the pane-title path altogether. Discriminating between sessions is all rule 1
 * is needed for, since choosing between sessions is the bug being fixed.
 *
 * @param {{candidates: PaneSession[], clients: TmuxClient[]}} input
 * @returns {{chosen: TmuxClient|null, plain: TmuxClient|null, controlMode: boolean}}
 */
export function chooseTmuxClient({ candidates, clients }) {
  const windowId = candidates[0]?.windowId ?? null;
  // Keyed by session, which also collapses a window linked into one session at
  // two indexes - tmux allows that, and it is two rows for one candidate.
  const bySession = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]));
  const ranked = clients
    .filter((client) => bySession.has(client.sessionId))
    .map((client) => ({
      client,
      here: client.windowId === windowId ? 0 : 1,
      windows: bySession.get(client.sessionId).windowCount,
    }))
    .sort((a, b) => a.here - b.here || a.windows - b.windows)
    .map((entry) => entry.client);
  return {
    chosen: ranked[0] ?? null,
    plain: ranked.find((client) => !client.controlMode) ?? null,
    controlMode: ranked.some((client) => client.controlMode),
  };
}

/**
 * Every session every pane on the server belongs to, one row per session.
 *
 * The whole table rather than one pane's rows because tmux has no per-pane
 * query that reports all of them - `display-message` picks one and hides the
 * rest. It is small: fourteen rows and 514 bytes on a machine running seven
 * sessions, against `MAX_OUTPUT_BYTES` of a megabyte, and it runs on a click
 * rather than on the poll loop.
 *
 * @returns {Promise<PaneSession[]>}
 */
export async function listPaneSessions(exec, { tmuxEnv }) {
  const [cmd, args] = tmuxCommand(tmuxEnv, [
    'list-panes',
    '-a',
    '-F',
    '#{pane_id}\t#{session_id}\t#{window_id}\t#{session_windows}\t#{session_name}',
  ]);
  try {
    return parsePaneSessions(await exec(cmd, args, { timeoutMs: 5000 }));
  } catch {
    return [];
  }
}

/**
 * Every client attached to the server.
 *
 * Deliberately not `-t <session>`: we have to weigh clients across several
 * sessions at once, and a `-t` on a *name* prefix-matches - `-t hv-sls-7` really
 * does return the client on `hv-sls-75-4d7a 🔔`.
 *
 * @returns {Promise<TmuxClient[]>} empty means nothing is attached
 */
export async function listClients(exec, { tmuxEnv }) {
  const [cmd, args] = tmuxCommand(tmuxEnv, [
    'list-clients',
    '-F',
    '#{client_tty}\t#{client_control_mode}\t#{session_id}\t#{window_id}',
  ]);
  try {
    return parseClients(await exec(cmd, args, { timeoutMs: 5000 }));
  } catch {
    return [];
  }
}

/**
 * The pane's title, which is the only handle iTerm2 gives us on a control mode
 * pane - it names each one after its tmux title, and exposes no tty for them.
 *
 * Not session-ambiguous the way the session lookup was: a title is a property
 * of the pane, so there is one right answer whichever session tmux resolves
 * through.
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
 * Bring the pane to the front inside the session the chosen client is looking
 * at, so that when the window comes forward the right pane is already showing.
 *
 * `select-window -t %356` is session-ambiguous exactly as the old session lookup
 * was, and worse: tmux picked a session and switched *that* client's current
 * window, so focusing a worker dragged an unrelated tab onto it and left it
 * there. `$204:@349` names one window in one session and nothing else.
 *
 * There is no guard for "the client already shows it": tmux's own
 * `session_set_current` does nothing when the target window is already current,
 * so the call is a no-op and a flag would only be state to keep true.
 *
 * `select-pane` needs no session prefix - the active pane is a property of the
 * window, which every session sharing it sees the same way.
 */
export async function selectPane(exec, { pane, tmuxEnv, sessionId, windowId }) {
  const [cmd, windowArgs] = tmuxCommand(tmuxEnv, [
    'select-window',
    '-t',
    `${sessionId}:${windowId}`,
  ]);
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
 * `tty` and `sessionId` come from the best *plain* client, because that is the
 * only kind whose tty names a window you can see. When every client is in
 * control mode there is no such tty, and `controlMode` says so rather than
 * handing back the control client's and letting the caller raise the wrong tab.
 *
 * @typedef {object} TmuxTarget
 * @property {boolean} ok
 * @property {string|null} session name of the session we will act in, for messages
 * @property {string|null} sessionId null when only a control client is attached
 * @property {string|null} windowId a property of the pane, so the same in every session
 * @property {string|null} tty
 * @property {boolean} controlMode
 * @property {string|null} title
 * @property {string} [reason]
 * @property {string} [hint]
 *
 * @returns {Promise<TmuxTarget>}
 */
export async function resolveTmuxTarget(exec, { pane, tmuxEnv }) {
  const paneSessions = await listPaneSessions(exec, { tmuxEnv });
  // Fewest windows first, so every fallback below names the session most likely
  // to be a viewer dedicated to this pane rather than somebody's working view.
  const candidates = paneSessions
    .filter((row) => row.paneId === pane)
    .sort((a, b) => a.windowCount - b.windowCount);
  if (candidates.length === 0) {
    // Both causes land here: the command failed (no server, wrong socket), and
    // the command succeeded but named no session for this pane.
    return {
      ok: false,
      session: null,
      sessionId: null,
      windowId: null,
      tty: null,
      controlMode: false,
      title: null,
      reason: 'pane-gone',
      hint: 'That tmux pane no longer exists.',
    };
  }

  const clients = await listClients(exec, { tmuxEnv });
  const { chosen, plain, controlMode } = chooseTmuxClient({ candidates, clients });
  if (!chosen) {
    return {
      ok: false,
      session: candidates[0].sessionName,
      sessionId: null,
      windowId: candidates[0].windowId,
      tty: null,
      controlMode: false,
      title: null,
      reason: 'detached',
      hint: `tmux attach -t ${shellQuote(candidates[0].sessionName)}`,
    };
  }

  const acting = plain ?? chosen;
  return {
    ok: true,
    session: candidates.find((row) => row.sessionId === acting.sessionId)?.sessionName ?? null,
    sessionId: plain ? plain.sessionId : null,
    windowId: candidates[0].windowId,
    tty: plain ? plain.tty : null,
    controlMode,
    title: controlMode ? await paneTitle(exec, { pane, tmuxEnv }) : null,
  };
}
