/**
 * Command line parsing.
 *
 * Extracted from the CLI so it can be tested directly. It was originally
 * inline, where `raise --help` silently started a server: the leading flag was
 * taken as the command name and never parsed as a flag.
 */

/** Commands are bare words; anything starting with a dash is a flag. */
export function parseArgv(argv) {
  const [rawCommand, ...rest] = argv;
  const isCommand = Boolean(rawCommand) && !rawCommand.startsWith('-');
  const args = isCommand ? rest : [rawCommand, ...rest].filter(Boolean);
  const { flags, positional } = parseFlags(args);
  return {
    command: isCommand ? rawCommand : 'serve',
    flags,
    positional,
    wantsHelp: Boolean(flags.help || flags.h) || rawCommand === 'help',
  };
}

export function parseFlags(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (argv[i + 1] && !argv[i + 1].startsWith('-')) {
        flags[name] = argv[i + 1];
        i += 1;
      } else {
        flags[name] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const short of arg.slice(1)) flags[short] = true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}
