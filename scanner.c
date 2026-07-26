// tree-sitter-fourd — external scanner
//
// Everything in here exists because 4D overloads its sigils in ways that a
// context-free lexer cannot resolve. The lever is `valid_symbols`: it tells us
// which tokens the *parser* can accept at this exact position, so `[[` can be a
// char-reference in postfix position and two collection literals at expression
// start, without the lexer ever guessing.
//
// Returning false from the scanner resets the lexer to the token start, so we
// can advance freely for lookahead and bail out cheaply.

#include "tree_sitter/parser.h"
#include <string.h>
#include <wctype.h>

#include "builtins.h"  // generated: fourd_builtin_kind(), is_builtin_prefix()

enum TokenType {
  TERMINATOR,        // significant newline
  FUNCTION_START,    // zero-width marker before <modifiers> Function|Class constructor
  CHAR_REF_OPEN,     // [[  (postfix only)
  CHAR_REF_CLOSE,    // ]]
  TIME_LITERAL,      // ?HH:MM:SS?
  DATE_LITERAL,      // !YYYY-MM-DD!  or  !!
  SQL_CONTENT,       // raw body of Begin SQL ... End SQL
  COMMAND_NAME,      // untokenized command, e.g. SET WINDOW TITLE
  CONSTANT_NAME,     // untokenized constant, e.g. Is text
  SYSTEM_VARIABLE,   // reserved: OK, Error, Document, ...
  ERROR_SENTINEL,    // never valid in a real state — see below
};

static inline void adv(TSLexer *l)  { l->advance(l, false); }
static inline void skip(TSLexer *l) { l->advance(l, true); }
static inline bool is_space(int32_t c) { return c == ' ' || c == '\t' || c == '\r'; }

// ---------------------------------------------------------------- modifiers

static const char *const MODIFIERS[] = {
  "shared", "session", "singleton", "exposed", "local", "server", "onHTTPGet",
};

static bool is_modifier(const char *w) {
  for (size_t i = 0; i < sizeof(MODIFIERS) / sizeof(*MODIFIERS); i++) {
    if (strcmp(w, MODIFIERS[i]) == 0) return true;
  }
  return false;
}

// Reads one [A-Za-z] word into buf. Returns length (0 = no word).
static int read_word(TSLexer *l, char *buf, int cap) {
  int n = 0;
  while (iswalpha(l->lookahead) && n < cap - 1) {
    buf[n++] = (char)l->lookahead;
    adv(l);
  }
  buf[n] = '\0';
  return n;
}

// ---------------------------------------------------------------- literals

// ?HH:MM:SS? — must have no whitespace after the opening '?', which is the
// tiebreaker against the ternary operator. `$flag ? 12 : 00` stays a ternary;
// `?12:00:00?` is a time. The pathological `$flag?12:00:00?$y` resolves to the
// literal — documented limitation, rare in practice.
static bool scan_time(TSLexer *l) {
  adv(l);                                     // '?'
  if (!iswdigit(l->lookahead)) return false;  // "? " or "?+" -> not a literal

  for (int part = 0; part < 3; part++) {
    int digits = 0;
    int max = (part == 0) ? 3 : 2;            // hours may exceed 24
    while (iswdigit(l->lookahead) && digits < max) { adv(l); digits++; }
    if (digits == 0) return false;
    if (part < 2) {
      if (l->lookahead != ':') return false;
      adv(l);
    }
  }
  if (l->lookahead != '?') return false;
  adv(l);
  l->mark_end(l);
  l->result_symbol = TIME_LITERAL;
  return true;
}

// Date literal. ISO !YYYY-MM-DD! is the documented standard form, but 4D also
// accepts two-digit years for compatibility (!12/04/98!) and, under "Use
// regional system settings", the system's own delimiter — slash or period.
//
// There is NO `!!` shorthand: the null date is spelled !00-00-00! and falls out
// of the general rule with no special case. The Code Editor's "type ! and press
// Enter" shortcut expands to the full literal, so `!!` never reaches source.
//
// Both delimiters must match; !2024-01/21! is not a date.
static bool scan_date(TSLexer *l) {
  adv(l);                                     // '!'
  int32_t sep = 0;

  for (int part = 0; part < 3; part++) {
    int digits = 0;
    while (iswdigit(l->lookahead) && digits < 4) { adv(l); digits++; }
    if (digits == 0) return false;

    if (part < 2) {
      int32_t c = l->lookahead;
      if (c != '-' && c != '/' && c != '.') return false;
      if (sep == 0) sep = c;
      else if (c != sep) return false;
      adv(l);
    }
  }

  if (l->lookahead != '!') return false;
  adv(l);
  l->mark_end(l);
  l->result_symbol = DATE_LITERAL;
  return true;
}

// ---------------------------------------------------------------- SQL block

// Consume raw text up to (not including) the terminator line.
//
// 4D requires `End SQL` to be ALONE on its line — not even a trailing comment
// is permitted. We enforce that strictly rather than leniently, and the payoff
// is robustness: SQL content containing the text "End SQL" inside a string
// literal or mid-line comment cannot false-terminate the block.
static bool scan_sql(TSLexer *l) {
  bool any = false;
  for (;;) {
    if (l->eof(l)) break;

    // At the start of a line, test for the terminator before consuming it.
    l->mark_end(l);
    while (is_space(l->lookahead)) adv(l);

    char w[16];
    int n = read_word(l, w, sizeof(w));
    if (n == 3 && fourd_stricmp(w, "end") == 0) {
      while (is_space(l->lookahead)) adv(l);
      n = read_word(l, w, sizeof(w));
      if (n == 3 && fourd_stricmp(w, "sql") == 0) {
        // Nothing but whitespace may follow, or this is not the terminator.
        while (is_space(l->lookahead)) adv(l);
        if (l->lookahead == '\n' || l->eof(l)) break;   // mark_end already set
      }
    }

    // Not the terminator — swallow the rest of the line.
    while (l->lookahead && l->lookahead != '\n') adv(l);
    if (l->lookahead == '\n') adv(l);
    any = true;
  }
  if (!any) return false;
  l->result_symbol = SQL_CONTENT;
  return true;
}

// ---------------------------------------------------------------- builtins

// Untokenized fallback for commands, constants and reserved system variables.
// Source that still carries `:C41` / `:K8:3` suffixes never reaches this path.
//
// Scan words greedily, marking the end after every prefix that is a known
// builtin; the last mark wins. This is what makes `Current date+1` split
// correctly instead of swallowing `date` into an identifier.
static bool scan_builtin(TSLexer *l, const bool *valid) {
  char buf[FOURD_MAX_BUILTIN_LEN];
  int len = 0;
  unsigned char best = 0;

  // Only accept kinds the parser can use here — a constant-only name must not
  // match where the parser cannot accept a constant.
  const unsigned char want = (valid[COMMAND_NAME]    ? FOURD_COMMAND  : 0)
                           | (valid[CONSTANT_NAME]   ? FOURD_CONSTANT : 0)
                           | (valid[SYSTEM_VARIABLE] ? FOURD_SYSVAR   : 0);
  if (!want) return false;

  for (int word = 0; word < FOURD_MAX_BUILTIN_WORDS; word++) {
    if (!iswalpha(l->lookahead) && l->lookahead != '_') break;

    while ((iswalnum(l->lookahead) || l->lookahead == '_') &&
           len < (int)sizeof(buf) - 2) {
      buf[len++] = (char)l->lookahead;
      adv(l);
    }
    buf[len] = '\0';

    unsigned char kind = fourd_builtin_kind(buf) & want;
    if (kind) { l->mark_end(l); best = kind; }

    if (!is_builtin_prefix(buf)) break;      // nothing extends this prefix
    if (l->lookahead != ' ' || len >= (int)sizeof(buf) - 2) break;
    adv(l);
    buf[len++] = ' ';
  }

  if (!best) return false;

  // CRITICAL: the external scanner runs BEFORE the internal lexer, so without
  // this check `Current date:C33` gets its name half claimed here as an
  // untokenized command_name, stranding `:C33` and cascading errors upward.
  // A ':C' or ':K' following the match means this is tokenized source and the
  // grammar's regex owns the whole thing — stand down.
  if (l->lookahead == ':') {
    adv(l);
    if (l->lookahead == 'C' || l->lookahead == 'K') return false;
  }

  // Namespaces are disjoint by design — the generator hard-errors on overlap —
  // so at most one bit is ever set. The ordering here is a safety net only.
  l->result_symbol = (best & FOURD_COMMAND)  ? COMMAND_NAME
                   : (best & FOURD_CONSTANT) ? CONSTANT_NAME
                                             : SYSTEM_VARIABLE;
  return true;
}

// ---------------------------------------------------------------- entrypoint

bool tree_sitter_fourd_external_scanner_scan(void *payload, TSLexer *l,
                                             const bool *valid_symbols) {
  (void)payload;

  // During error recovery tree-sitter marks EVERY token valid, including tokens
  // that scan greedily to a terminator. Without this guard a stray '\\' inside
  // an object literal put the parser in error recovery, SQL_CONTENT was then
  // "valid", and scan_sql swallowed the rest of the file. The sentinel appears
  // in no rule, so it is valid only in that recovery state.
  if (valid_symbols[ERROR_SENTINEL]) return false;

  // SQL bodies are raw — bail out before any whitespace handling.
  if (valid_symbols[SQL_CONTENT]) return scan_sql(l);

  // --- whitespace, line continuation, significant newline -------------------
  for (;;) {
    if (is_space(l->lookahead)) {
      skip(l);
      continue;
    }
    // Line continuation is handled by `extras` in grammar.js, not here.
    if (l->lookahead == '\n') {
      if (valid_symbols[TERMINATOR]) {
        adv(l);
        l->mark_end(l);
        l->result_symbol = TERMINATOR;
        return true;
      }
      skip(l);                                   // inside brackets: not a terminator
      continue;
    }
    break;
  }

  if (l->eof(l)) return false;

  // --- zero-width function marker -------------------------------------------
  // Emitted only when a declaration is legal here, which is what stops a
  // process variable named `local` or `server` from being read as a modifier.
  if (valid_symbols[FUNCTION_START]) {
    l->mark_end(l);                              // zero width, whatever we scan
    char w[32];
    for (int i = 0; i < 8; i++) {
      if (read_word(l, w, sizeof(w)) == 0) return false;

      if (strcmp(w, "Function") == 0) {
        l->result_symbol = FUNCTION_START;
        return true;
      }
      if (strcmp(w, "Class") == 0) {
        while (is_space(l->lookahead)) adv(l);
        if (read_word(l, w, sizeof(w)) == 0) return false;
        if (strcmp(w, "constructor") != 0) return false;  // `Class extends` is separate
        l->result_symbol = FUNCTION_START;
        return true;
      }
      if (!is_modifier(w)) return false;
      while (is_space(l->lookahead)) adv(l);
    }
    return false;
  }

  // --- context-gated brackets -----------------------------------------------
  // `[[` is a char reference only where a postfix operator is legal. At
  // expression start the parser does not accept CHAR_REF_OPEN, so
  // `[[1;2];[3;4]]` lexes as two plain '[' and stays a nested collection.
  if (valid_symbols[CHAR_REF_OPEN] && l->lookahead == '[') {
    adv(l);
    if (l->lookahead != '[') return false;
    adv(l);
    l->mark_end(l);
    l->result_symbol = CHAR_REF_OPEN;
    return true;
  }
  if (valid_symbols[CHAR_REF_CLOSE] && l->lookahead == ']') {
    adv(l);
    if (l->lookahead != ']') return false;
    adv(l);
    l->mark_end(l);
    l->result_symbol = CHAR_REF_CLOSE;
    return true;
  }

  // --- literals -------------------------------------------------------------
  if (valid_symbols[TIME_LITERAL] && l->lookahead == '?') return scan_time(l);
  if (valid_symbols[DATE_LITERAL] && l->lookahead == '!') return scan_date(l);

  // --- untokenized builtins -------------------------------------------------
  if ((valid_symbols[COMMAND_NAME] || valid_symbols[CONSTANT_NAME] ||
       valid_symbols[SYSTEM_VARIABLE]) &&
      (iswalpha(l->lookahead) || l->lookahead == '_')) {
    return scan_builtin(l, valid_symbols);
  }

  return false;
}

// No state to carry: every decision is made from valid_symbols + lookahead.
void *tree_sitter_fourd_external_scanner_create(void) { return NULL; }
void  tree_sitter_fourd_external_scanner_destroy(void *p) { (void)p; }
void  tree_sitter_fourd_external_scanner_deserialize(void *p, const char *b, unsigned n) {
  (void)p; (void)b; (void)n;
}
unsigned tree_sitter_fourd_external_scanner_serialize(void *p, char *b) {
  (void)p; (void)b;
  return 0;
}
