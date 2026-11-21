// A fast drop-in for csv-reader 1.0.0: the same answers, without the one
// character at a time loop.
//
// Where the reference builds every field up a character at a time, this
// reader slices fields wholesale: an unquoted field is one slice up to the
// next comma or line break (found with a single regex scan), and a quoted field is found
// with indexOf('"') jumps from quote to quote. Only the rare broken bits
// slow down: a stray CR is dropped one at a time, a "" escape or an embedded
// line break inside quotes is fixed up for that field alone. Line numbers
// are kept per record and per quoted span, never per character, so the error
// records still come out in exactly csv-reader's order and attribution.
//
// Pure: no clock, no randomness, no locale, nothing kept from one call to
// the next. Strings are worked on by UTF-16 code unit throughout, as the
// reference does.

// How a field ended: at a comma (the record goes on), at a line break or at
// the end of the text (the record ends).
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The reading of one CSV input, {text, header}: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line that character is on

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  const error = (code) => {
    errors.push({ code, line: recordLine, row: recordRow });
  };

  // How many line breaks s holds: a CRLF counts once, a lone CR once, an LF once.
  const countBreaks = (s) => {
    const m = s.match(/\r\n?|\n/g);
    return m === null ? 0 : m.length;
  };

  // Append a span from inside a quoted field to value: every CRLF or lone CR
  // in it becomes one LF, and the line advances past the breaks it held.
  const addSpan = (value, span) => {
    if (span.indexOf('\n') < 0 && span.indexOf('\r') < 0) return value + span;
    line += countBreaks(span);
    return span.indexOf('\r') < 0 ? value + span : value + span.replace(/\r\n?/g, '\n');
  };

  // Reads unquoted characters onto `value` up to the next comma or line break:
  // a CR not followed by LF is dropped (stray_cr). Returns the field, how it
  // ended, and how many characters were kept.
  //
  // The next delimiter is found with one regex exec, not three indexOf
  // calls: a single scan stops at the first comma, CR or LF, whichever it is.
  const DELIM_RE = /[,\r\n]/g;
  const readUnquoted = (value) => {
    let added = 0;
    let start = pos;
    for (;;) {
      DELIM_RE.lastIndex = pos;
      const m = DELIM_RE.exec(text);
      let d = -1;
      let kind = -1; // 0 comma, 1 LF, 2 CR
      if (m !== null) {
        d = m.index;
        const ch = m[0];
        kind = ch === ',' ? 0 : ch === '\n' ? 1 : 2;
      }
      if (d === -1) {
        added += n - start;
        value += text.slice(start);
        pos = n;
        return { value, ended: END, added };
      }
      if (kind === 2) {
        if (text.charCodeAt(d + 1) === 10) {
          added += d - start;
          value += text.slice(start, d);
          pos = d + 2;
          line += 1;
          return { value, ended: LINE_BREAK, added };
        }
        error('stray_cr');
        added += d - start;
        value += text.slice(start, d);
        pos = d + 1;
        start = pos;
        continue;
      }
      added += d - start;
      value += text.slice(start, d);
      pos = d + 1;
      if (kind === 1) line += 1;
      return { value, ended: kind === 0 ? COMMA : LINE_BREAK, added };
    }
  };

  // Reads a quoted field whose opening quote is at pos.
  const readQuoted = () => {
    const open = pos;
    const openLine = line;
    let value = '';
    pos += 1;
    let start = pos;
    for (;;) {
      const q = text.indexOf('"', pos);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        error('unterminated_quote');
        return readUnquoted('"');
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote inside: one quote in the value, and on past the pair.
        value = addSpan(value, text.slice(start, q));
        value += '"';
        pos = q + 2;
        start = pos;
        continue;
      }
      value = addSpan(value, text.slice(start, q));
      pos = q + 1;
      break;
    }
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: LINE_BREAK, added: 0 };
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const junk = readUnquoted(value);
    if (junk.added > 0) error('quote_junk');
    return junk;
  };

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
