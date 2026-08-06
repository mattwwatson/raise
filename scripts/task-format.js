/**
 * The few characters of presentation the roadmap commands share.
 *
 * Colour is a parameter here and never a module-level fact. The original
 * decided it once at import from `process.stdout.isTTY`, which makes every
 * renderer TTY-dependent: a test asserting on a column has to assert on escape
 * codes as well, or strip them first and hope the stripping is right. The entry
 * script resolves colour once and passes it down, so each renderer stays a pure
 * function of its data and `colour: false` is what the suite reads.
 */

/**
 * ANSI codes by the name the renderers use, rather than by number at the call
 * site. `ready` is bold cyan because READY is the one word on the board you are
 * scanning for.
 */
export const ANSI = Object.freeze({
  bold: '1',
  dim: '2',
  red: '31',
  green: '32',
  yellow: '33',
  cyan: '36',
  ready: '1;36',
});

/** What `truncate` leaves behind, and it counts as one column. */
export const ELLIPSIS = '…';

/**
 * A paint function bound to one colour decision.
 *
 * @param {boolean} colour
 * @returns {(code: string, text: string) => string}
 */
export function painter(colour) {
  return (code, text) => (colour ? `\x1b[${code}m${text}\x1b[0m` : text);
}

/**
 * Widen to a column, never narrow.
 *
 * Padding a value that is already too long has to leave it alone: a ticket key
 * or a status word that overflows its column is worth seeing whole, and
 * silently cutting it is how a board stops matching the files it describes.
 * `truncate` is the one that shortens, and only the title column asks for it.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function pad(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

/**
 * Shorten to a column, marking that it happened.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function truncate(text, width) {
  const value = String(text ?? '');
  if (value.length <= width) return value;
  return value.slice(0, Math.max(0, width - 1)) + ELLIPSIS;
}

/**
 * One fixed-width column: shortened if it has to be, then widened.
 *
 * @param {string} text
 * @param {number} width
 * @returns {string}
 */
export function cell(text, width) {
  return pad(truncate(text, width), width);
}
