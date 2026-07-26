/// <reference types="tree-sitter-cli/dsl" />
// tree-sitter-fourd — targets 4D 21 R4.
//
// Skeleton: the hard structural decisions are wired, the long tail of
// statements and types is left as TODO.

// C ordering: the short-circuit operators sit BELOW their bitwise counterparts,
// so `$a | $b && $c` groups as `($a | $b) && $c`.
const PREC = {
  ASSIGN:    0,   // :=  +=  ...  (usable inside Formula(...) etc.)
  TERNARY:   1,
  LOGIC_OR:  2,   // ||   short-circuit
  LOGIC_AND: 3,   // &&   short-circuit
  OR:        4,   // |
  AND:       5,   // &
  EQUALITY:  6,   // =  #
  RELATION:  7,   // <  >  <=  >=
  SHIFT:     8,   // << >>
  ADDITIVE:  9,   // +  -
  MULTIPLY: 10,   // *  /  %  backslash (integer division)
  UNARY:    11,   // -  ->  (pointer creation)
  POSTFIX:  12,   // .member  [i]  {i}  [[i]]  ->  (deref)
};

// Multi-word keyword. A plain string literal would demand exactly one space;
// this tolerates whatever the method editor emits. prec 2 puts it above
// `identifier` so `End if` never lexes as two identifiers. Longest-match means
// `End for each` still beats `End for` without extra bookkeeping.
function kw(...words) {
  // First letter of each word is case-insensitive: hand-edited files contain
  // `case of` / `end case`, which 4D accepts and its editor normalizes.
  const ci = w => '[' + w[0].toUpperCase() + w[0].toLowerCase() + ']' + w.slice(1);
  return token(prec(2, new RegExp(words.map(ci).join('\\s+'))));
}

module.exports = grammar({
  name: 'fourd',

  // The scanner emits _terminator for meaningful newlines; any newline it
  // declines to claim falls through to extras and is discarded.
  // The line continuation belongs HERE, not in the scanner. The scanner is only
  // invoked in states where some external token is valid, so a '\' immediately
  // after '{' was never seen by it. As an extra it is skipped everywhere.
  // Longest-match keeps it clear of '\' the integer-division operator, which is
  // never followed by a newline.
  extras: $ => [
    /[ \t\r\n\uFEFF]/,   // include the BOM: real files start with one (or two)
    $.line_continuation,
    $.line_comment,
    $.block_comment,
  ],

  externals: $ => [
    $._terminator,
    $._function_start,
    $.char_ref_open,
    $.char_ref_close,
    $.time_literal,
    $.date_literal,
    $.sql_content,
    $.command_name,      // untokenized: SET WINDOW TITLE
    $.constant_name,     // untokenized: Is text
    $.system_variable,   // reserved: OK, Error, Document
    $._error_sentinel,   // never used in a rule; see scanner.c
  ],

  // No declared conflicts. The `Try` ambiguity resolves itself: try_statement
  // requires a _terminator immediately after `Try`, try_expression requires
  // '('. One token of lookahead separates them, so this is plain LR(1).

  word: $ => $.identifier,

  rules: {
    // Ordering here is load-bearing, not cosmetic. Function bodies are
    // repeat($._statement) with no closing token, so if bare statements were
    // also legal AFTER a function, every trailing statement would be ambiguous
    // between "last statement of the body" and "next top-level statement".
    // Forbidding statements after the first function removes the ambiguity and
    // matches the language: a method file has statements and no functions, a
    // class file has functions and no free statements.
    source_file: $ => seq(
      optional($.attributes_header),   // // %attributes = { ... }
      repeat(choice($.extends_clause, $.property_declaration)),
      repeat($._statement),
      repeat($.function_declaration),
    ),

    // ---------------------------------------------------------------- classes

    extends_clause: $ => seq(kw('Class', 'extends'), field('super', $.identifier), $._terminator),

    // Mirrors var_declaration: `property a; b : Text` declares several names
    // sharing one type, and `: Type := default` / bare `:= default` are the
    // one-line initialization forms.
    property_declaration: $ => seq(
      'property',
      field('name', $.identifier),
      repeat(seq(';', field('name', $.identifier))),
      optional(seq(':', field('type', $._type))),
      optional(seq(':=', field('default', $._expression))),
      $._terminator,
    ),

    // Bodies are IMPLICITLY terminated: 4D ends a function at the next
    // Function/Class constructor or at EOF. The scanner's zero-width
    // _function_start marker is what lets repeat($._statement) know to stop —
    // and what stops a process variable named `local` from reading as a
    // modifier.
    function_declaration: $ => seq(
      $._function_start,
      repeat(field('modifier', $.modifier)),
      choice(
        kw('Class', 'constructor'),
        seq(choice('Function', 'function'),   // keyword case is not enforced in the wild
            // get/set computed-attribute accessors, plus the ORDA markers:
            // `Function event restrict`, `Function query attr`, `Function orderBy attr`
            optional(field('accessor', choice('get', 'set', 'event', 'query', 'orderBy'))),
            // Optional: `Function get($range : Object)` is a function NAMED
            // get — keyword lexing claims it as accessor, and the name slot
            // stays empty. Parses fine; consumers read accessor-with-no-name.
            optional(field('name', choice($.identifier, $.multiword_name)))),
      ),
      optional($.parameter_list),
      // Same two return forms as #DECLARE: `-> $out : Type` or `: Type`.
      optional(choice(
        seq('->', field('return', $.parameter)),
        seq(':', field('return_type', $._type)),
      )),
      $._terminator,
      field('body', repeat($._statement)),
    ),

    // Deliberately permissive. Which modifier is legal where (exposed only on
    // ORDA/singleton functions, session only on classes, ...) is a lint rule,
    // not a grammar rule.
    modifier: $ => choice(
      'shared', 'session', 'singleton', 'exposed', 'local', 'server', 'onHTTPGet',
    ),

    parameter_list: $ => seq(
      '(',
      optional(seq($.parameter, repeat(seq(';', $.parameter)))),
      ')',
    ),

    // Two shapes: `$name : Type`, or the variadic `... : Type` — the ellipsis
    // is NAMELESS in the documented form (`#DECLARE(... : Real)`), must sit
    // last, and its extra arguments are reached via ${N} indirection. The
    // optional name after '...' is permissiveness, not documentation.
    // "Last position only" is a lint rule, not a grammar rule (§5.6 stance).
    parameter: $ => choice(
      seq(field('name', $.local_variable),
          optional(seq(':', field('type', $._type)))),
      seq('...',
          optional(field('name', $.local_variable)),
          optional(seq(':', field('type', $._type)))),
    ),

    // ------------------------------------------------------------ statements

    _statement: $ => choice(
      $.var_declaration,
      $.if_statement,
      $.case_statement,
      $.while_statement,
      $.repeat_statement,
      $.for_statement,
      $.for_each_statement,
      $.try_statement,
      $.sql_block,
      $.declare_statement,
      $.jump_statement,
      $.expression_statement,
    ),

    // An EXPRESSION, not a statement: `Formula(Form.x.y:=$1)` assigns inside
    // an argument list. Statement-position assignments come out as
    // expression_statement(assignment). Lowest precedence, right-assoc.
    assignment: $ => prec.right(PREC.ASSIGN, seq(
      field('left', $._expression),
      field('operator', choice(':=', '+=', '-=', '*=', '/=')),
      field('right', $._expression),
    )),

    // Names are plain tokens, not expressions — required now that ':=' is an
    // expression operator, and truer to the docs (no interprocess/array vars).
    // Real code separates names with ',' as well as ';'.
    var_declaration: $ => seq(
      'var',
      field('name', $._var_name),
      repeat(seq(choice(';', ','), field('name', $._var_name))),
      optional(seq(':', field('type', $._type))),
      optional(seq(':=', field('value', $._expression))),
      $._terminator,
    ),

    _var_name: $ => choice(
      $.local_variable, $.identifier,
      $.interprocess_variable,        // docs exclude it; the corpus does not
      $.parameter_indirection,        // `var ${2}` — legacy positional params
    ),

    // 21 R4 keywords are lowercase, which keeps them clear of the Capitalized /
    // ALL-CAPS builtin namespace. `defer` is call-shaped, not a block.
    jump_statement: $ => seq(
      choice(
        seq('return', optional($._expression)),
        'break',
        'continue',
        seq('throw', optional(seq('(', optional($._argument_list), ')'))),
        seq('defer', '(', $._expression, ')'),
      ),
      $._terminator,
    ),

    // #DECLARE($p : Text) -> $out : Object
    // token() so it outlengths '#', which is the not-equal operator.
    declare_statement: $ => seq(
      token('#DECLARE'),
      optional($.parameter_list),
      // Both return forms: `-> $out : Type` names the output variable;
      // `: Type` alone pairs with a `return` statement — same as Function.
      optional(choice(
        seq('->', field('return', $.parameter)),
        seq(':', field('return_type', $._type)),
      )),
      $._terminator,
    ),

    // The parenthesis after `If` is NOT statement syntax — it is the start of
    // an ordinary parenthesized expression. 4D happily accepts
    //   If ($a=1) | ($b=2) | Match regex:C1019("\\d"; $c)
    // where the condition is the whole `|` chain. Hard-coding '(' ... ')'
    // here truncated the condition at the first ')' and errored on the '|'.
    // Same reasoning applies to While / Until / case branches below. For and
    // For each keep their parens: there the parens genuinely delimit a
    // ';'-separated header.
    if_statement: $ => seq(
      'If', field('condition', $._expression), $._terminator,
      field('consequence', repeat($._statement)),
      optional(seq('Else', $._terminator, field('alternative', repeat($._statement)))),
      kw('End', 'if'), $._terminator,
    ),

    // Branches are implicitly terminated, same shape as function bodies: the
    // next ':' / 'Else' / 'End case' closes the previous one. No scanner help
    // needed — no statement can begin with ':', and ':=' out-lexes it.
    case_statement: $ => seq(
      kw('Case', 'of'), $._terminator,
      repeat($.case_branch),
      optional(seq('Else', $._terminator, field('alternative', repeat($._statement)))),
      kw('End', 'case'), $._terminator,
    ),

    case_branch: $ => seq(
      ':', field('condition', $._expression), $._terminator,
      field('body', repeat($._statement)),
    ),

    while_statement: $ => seq(
      'While', field('condition', $._expression), $._terminator,
      repeat($._statement),
      kw('End', 'while'), $._terminator,
    ),

    repeat_statement: $ => seq(
      'Repeat', $._terminator,
      repeat($._statement),
      'Until', field('condition', $._expression), $._terminator,
    ),

    for_statement: $ => seq(
      'For', '(',
        field('counter', $._expression), ';',
        field('start', $._expression), ';',
        field('end', $._expression),
        optional(seq(';', field('step', $._expression))),
      ')', $._terminator,
      repeat($._statement),
      kw('End', 'for'), $._terminator,
    ),

    for_each_statement: $ => seq(
      kw('For', 'each'), '(',
        field('item', $._expression), ';',
        field('collection', $._expression),
        repeat(seq(';', $._expression)),
      ')',
      optional(seq(choice('Until', 'While'), field('guard', $._expression))),
      $._terminator,
      repeat($._statement),
      kw('End', 'for', 'each'), $._terminator,
    ),

    try_statement: $ => seq(
      'Try', $._terminator,
      field('body', repeat($._statement)),
      optional(seq('Catch', $._terminator, field('handler', repeat($._statement)))),
      kw('End', 'try'), $._terminator,
    ),

    sql_block: $ => seq(
      kw('Begin', 'SQL'), $._terminator,
      field('body', optional($.sql_content)),
      kw('End', 'SQL'), $._terminator,
    ),

    // Real code carries JS-habit trailing semicolons (`$b.analyse();`);
    // 4D tolerates them, so we do.
    expression_statement: $ => seq($._expression, optional(';'), $._terminator),

    // ----------------------------------------------------------- expressions

    _expression: $ => choice(
      $.assignment,
      $.binary_expression,
      $.unary_expression,
      $.ternary_expression,
      $.try_expression,
      $.postfix_expression,
      $._primary,
    ),

    binary_expression: $ => {
      const table = [
        // '||' and '&&' must precede '|' and '&' in no particular order here —
        // the lexer's longest-match rule is what keeps them distinct.
        [PREC.LOGIC_OR,  '||'],
        [PREC.LOGIC_AND, '&&'],
        [PREC.OR,       choice('|', '^|')],
        [PREC.AND,      '&'],
        [PREC.EQUALITY, choice('=', '#')],
        [PREC.RELATION, choice('<', '>', '<=', '>=')],
        // '??' bit test, '?+' bit set, '?-' bit clear. Longest-match keeps
        // them clear of ternary '?', which in practice is followed by a space.
        [PREC.SHIFT,    choice('<<', '>>', '??', '?+', '?-')],
        [PREC.ADDITIVE, choice('+', '-')],
        // '\\' is integer division. It is also the line-continuation marker;
        // the scanner tells them apart by whether anything but whitespace
        // follows to end of line.
        [PREC.MULTIPLY, choice('*', '/', '%', '\\', '^')],
      ];
      return choice(...table.map(([p, op]) => prec.left(p, seq(
        field('left', $._expression),
        field('operator', op),
        field('right', $._expression),
      ))));
    },

    // Space is the tiebreaker against ?HH:MM:SS? — the scanner only claims a
    // time literal when a digit immediately follows '?'.
    ternary_expression: $ => prec.right(PREC.TERNARY, seq(
      field('condition', $._expression), '?',
      field('consequence', $._expression), ':',
      field('alternative', $._expression),
    )),

    try_expression: $ => prec(PREC.UNARY, seq('Try', '(', $._expression, ')')),

    unary_expression: $ => prec.right(PREC.UNARY, seq(
      choice('-', '+', '->'),      // '->' prefix = pointer creation
      $._expression,
    )),

    postfix_expression: $ => prec.left(PREC.POSTFIX, choice(
      seq($._expression, '->'),                                        // deref
      seq($._expression, '.', field('member', choice($.identifier, $.local_variable))),
      seq($._expression, '(', optional($._argument_list), ')'),
      seq($._expression, '[', $._expression, ']'),                     // collection index
      seq($._expression, '{', $._expression, '}'),                     // legacy array element
      seq($._expression, $.char_ref_open, $._expression, $.char_ref_close),
    )),

    _argument_list: $ => seq($._argument, repeat(seq(choice(';', ','), $._argument))),

    // Commands accept marker parameters that are not expressions: the
    // trailing '*' (e.g. `Lowercase($c; *)`) and the '>' / '<' sort/locking
    // markers (`ORDER BY([T]; [T]F; >)`). '>' and '<' cannot begin an
    // expression, so this stays LR(1)-clean.
    _argument: $ => choice($._expression, '*', '>', '<', '&', '|'),

    _primary: $ => choice(
      // Tokenized forms — regex, no scanner involvement.
      $.command,
      $.constant,
      // Untokenized fallbacks. These MUST be reachable from a rule or the
      // parser never marks them valid, valid_symbols[COMMAND_NAME] stays false,
      // and the scanner's builtin table is dead code.
      $.command_name,
      $.constant_name,
      $.multiword_name,
      // Reserved and unshadowable, so they win over `identifier` outright.
      // Table-driven rather than a keyword list because some are multi-word.
      $.system_variable,
      $.field_reference,
      $.table_reference,
      $.collection_literal,
      $.object_literal,
      $.string,
      $.number,
      $.time_literal,
      $.date_literal,
      $.local_variable,
      $.parameter_indirection,
      $.interprocess_variable,
      $.identifier,
      seq('(', $._expression, ')'),
    ),

    // Untokenized multi-word command/constant/plugin-command names:
    // `WP UpdateWidget(...)`, `Form event code`, `Is BLOB`. Adjacent
    // identifiers are illegal everywhere else in the expression grammar, so a
    // greedy identifier run is unambiguous. The real scanner's command_name /
    // constant_name tokens still win where its builtin table matches.
    // Later words may be bare numbers (`TEST Sign Fake 2`); the first must be
    // an identifier so this can never start where a number literal belongs.
    multiword_name: $ => prec.right(seq($.identifier, repeat1(choice($.identifier, $.number)))),

    // Tokenized source. These two rules absorb ~1300 commands and several
    // thousand constants, every embedded space, and the French/English split —
    // builtins are always stored in English with a :C or :K suffix.
    // Leading digits are legal in the wild: methods named `00_Start`, and the
    // tokenized namespace `4D:C1709`. Number wins ties via token prec, so
    // `123` stays a number while `00_Start` and `4D` lex as identifiers.
    command:  $ => token(new RegExp('[A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF][A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF ]*:C[0-9]+')),
    constant: $ => token(new RegExp('[A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF][A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF ]*:K[0-9]+:[0-9]+')),

    // [Employees:1]Name:2 — the :N suffixes are also what distinguish a table
    // reference from a collection literal at expression start.
    field_reference: $ => token(seq(
      '[', /[A-Za-z_0-9][A-Za-z0-9_ ]*/, optional(/:\d+/), ']',
      /[A-Za-z_0-9][A-Za-z0-9_ ]*/, optional(/:\d+/),
    )),

    // `[CLIENTS:1]` with no trailing field — pointer targets etc. The :N
    // suffix is what lexically separates it from a collection literal;
    // field_reference still wins by longest match when a field follows.
    table_reference: $ => token(seq('[', /[A-Za-z_0-9][A-Za-z0-9_ ]*/, /:\d+/, ']')),

    collection_literal: $ => seq('[', optional($._argument_list), ']'),

    object_literal: $ => seq(
      '{',
      optional(seq($.object_pair, repeat(seq(';', $.object_pair)))),
      '}',
    ),
    // Property names are UNQUOTED in literal syntax — `{a: 1}`, not `{"a": 1}`
    // — and pairs are separated by ';', not ','. The notation resembles JSON
    // but is not JSON.
    object_pair: $ => seq(
      field('key', choice($.identifier, $.local_variable, $.string)),
      ':', field('value', $._expression),
    ),

    // ${N} parameter indirection: the index is a full expression (`${$i}`).
    // '${' is one token, so it cannot collide with local_variable — that
    // token requires an alphanumeric after '$' and dies on '{'.
    parameter_indirection: $ => seq('${', field('index', $._expression), '}'),

    local_variable:        $ => token(seq('$', /[A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF]+/)),
    interprocess_variable: $ => token(seq('<>', /[A-Za-z_\u00C0-\uFEFE\uFF00-\uFFFF][A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF]*/)),
    // Defined BEFORE identifier: lexical ties (`1e3`, `0xFF` match both at
    // equal length) resolve by rule order, earlier wins. No token prec here —
    // tree-sitter checks precedence before match LENGTH, so any prec on
    // number would make the 2-char `00` beat the 8-char `00_Start`.
    number: $ => /0[xX][0-9A-Fa-f]+|\d+(\.\d+)?([eE][-+]?\d+)?/,
    string: $ => token(seq('"', repeat(choice(/[^"\\\n]/, /\\./)), '"')),

    // Digit-leading branch requires a letter after the digits, so a pure
    // number can never lex as identifier. Unicode letters are legal (`ƒ`);
    // U+FEFF is carved out of the ranges so a BOM stays an extra.
    identifier:            $ => new RegExp('([A-Za-z_\u00C0-\uFEFE\uFF00-\uFFFF]|[0-9]+[A-Za-z_\u00C0-\uFEFE\uFF00-\uFFFF])[A-Za-z0-9_\u00C0-\uFEFE\uFF00-\uFFFF]*'),

    // Decimal with optional fraction and exponent (range is IEEE double,
    // ±1.7e±308), or 0x/0X hexadecimal — official command docs use
    // 0xFFFFFFFF as a literal. Longest-match keeps 0xFF from splitting into
    // number 0 + identifier xFF. No binary/octal form exists in 4D.

    // A dotted path: `Text`, `cs.MyClass`, `cs.AIKit.OpenAIChatHelper`,
    // `4D.File`, and the tokenized namespaces `cs:C1710.X` / `4D:C1709.X`
    // (commands, now that the command token admits a leading digit).
    // `cs` is an ordinary identifier; bare `4D` is not, hence the literal.
    _type: $ => prec.right(seq(
      choice($.identifier, $.command, '4D'),
      repeat(seq('.', $.identifier)),
    )),

    attributes_header: $ => token(seq('//', /\s*/, '%attributes', /[^\n]*/)),
    line_continuation: $ => token(seq('\\', /[ \t\r]*/, '\n')),
    // A '\' at end of a comment line continues the COMMENT onto the next
    // line — commented-out multi-line calls rely on this (their continuation
    // lines are not separately commented).
    line_comment:      $ => token(seq('//', /([^\n]*\\[ \t\r]*\n)*[^\n]*/)),
    block_comment:     $ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});
