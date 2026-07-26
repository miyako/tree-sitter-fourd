/// <reference types="tree-sitter-cli/dsl" />
// tree-sitter-fourd — targets 4D 21 R4.
//
// Skeleton: the hard structural decisions are wired, the long tail of
// statements and types is left as TODO.

// C ordering: the short-circuit operators sit BELOW their bitwise counterparts,
// so `$a | $b && $c` groups as `($a | $b) && $c`.
const PREC = {
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
  return token(prec(2, new RegExp(words.join('\\s+'))));
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
    /[ \t\r\n]/,
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

    property_declaration: $ => seq(
      'property',
      field('name', $.identifier),
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
        seq('Function',
            optional(field('accessor', choice('get', 'set'))),
            field('name', $.identifier)),
      ),
      optional($.parameter_list),
      optional(seq(':', field('return_type', $._type))),
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

    parameter: $ => seq(
      optional('...'),
      field('name', $.local_variable),
      optional(seq(':', field('type', $._type))),
    ),

    // ------------------------------------------------------------ statements

    _statement: $ => choice(
      $.assignment,
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

    assignment: $ => seq(
      field('left', $._expression),
      field('operator', choice(':=', '+=', '-=', '*=', '/=')),
      field('right', $._expression),
      $._terminator,
    ),

    var_declaration: $ => seq(
      'var',
      field('name', $._expression),
      repeat(seq(';', field('name', $._expression))),
      optional(seq(':', field('type', $._type))),
      optional(seq(':=', field('value', $._expression))),
      $._terminator,
    ),

    // 21 R4 keywords are lowercase, which keeps them clear of the Capitalized /
    // ALL-CAPS builtin namespace. `defer` is call-shaped, not a block.
    jump_statement: $ => seq(
      choice(
        seq('return', optional($._expression)),
        'break',
        'continue',
        seq('throw', optional(seq('(', optional($._expression), ')'))),
        seq('defer', '(', $._expression, ')'),
      ),
      $._terminator,
    ),

    // #DECLARE($p : Text) -> $out : Object
    // token() so it outlengths '#', which is the not-equal operator.
    declare_statement: $ => seq(
      token('#DECLARE'),
      optional($.parameter_list),
      optional(seq('->', field('return', $.parameter))),
      $._terminator,
    ),

    if_statement: $ => seq(
      'If', '(', field('condition', $._expression), ')', $._terminator,
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
      ':', '(', field('condition', $._expression), ')', $._terminator,
      field('body', repeat($._statement)),
    ),

    while_statement: $ => seq(
      'While', '(', field('condition', $._expression), ')', $._terminator,
      repeat($._statement),
      kw('End', 'while'), $._terminator,
    ),

    repeat_statement: $ => seq(
      'Repeat', $._terminator,
      repeat($._statement),
      'Until', '(', field('condition', $._expression), ')', $._terminator,
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
      ')', $._terminator,
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

    expression_statement: $ => seq($._expression, $._terminator),

    // ----------------------------------------------------------- expressions

    _expression: $ => choice(
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
        [PREC.OR,       '|'],
        [PREC.AND,      '&'],
        [PREC.EQUALITY, choice('=', '#')],
        [PREC.RELATION, choice('<', '>', '<=', '>=')],
        [PREC.SHIFT,    choice('<<', '>>')],
        [PREC.ADDITIVE, choice('+', '-')],
        // '\\' is integer division. It is also the line-continuation marker;
        // the scanner tells them apart by whether anything but whitespace
        // follows to end of line.
        [PREC.MULTIPLY, choice('*', '/', '%', '\\')],
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
      seq($._expression, '.', field('member', $.identifier)),
      seq($._expression, '(', optional($._argument_list), ')'),
      seq($._expression, '[', $._expression, ']'),                     // collection index
      seq($._expression, '{', $._expression, '}'),                     // legacy array element
      seq($._expression, $.char_ref_open, $._expression, $.char_ref_close),
    )),

    _argument_list: $ => seq($._expression, repeat(seq(';', $._expression))),

    _primary: $ => choice(
      // Tokenized forms — regex, no scanner involvement.
      $.command,
      $.constant,
      // Untokenized fallbacks. These MUST be reachable from a rule or the
      // parser never marks them valid, valid_symbols[COMMAND_NAME] stays false,
      // and the scanner's builtin table is dead code.
      $.command_name,
      $.constant_name,
      // Reserved and unshadowable, so they win over `identifier` outright.
      // Table-driven rather than a keyword list because some are multi-word.
      $.system_variable,
      $.field_reference,
      $.collection_literal,
      $.object_literal,
      $.string,
      $.number,
      $.time_literal,
      $.date_literal,
      $.local_variable,
      $.interprocess_variable,
      $.identifier,
      seq('(', $._expression, ')'),
    ),

    // Tokenized source. These two rules absorb ~1300 commands and several
    // thousand constants, every embedded space, and the French/English split —
    // builtins are always stored in English with a :C or :K suffix.
    command:  $ => token(/[A-Za-z_][A-Za-z0-9_ ]*:C\d+/),
    constant: $ => token(/[A-Za-z_][A-Za-z0-9_ ]*:K\d+:\d+/),

    // [Employees:1]Name:2 — the :N suffixes are also what distinguish a table
    // reference from a collection literal at expression start.
    field_reference: $ => token(seq(
      '[', /[A-Za-z_][A-Za-z0-9_ ]*/, optional(/:\d+/), ']',
      /[A-Za-z_][A-Za-z0-9_ ]*/, optional(/:\d+/),
    )),

    collection_literal: $ => seq('[', optional($._argument_list), ']'),

    object_literal: $ => seq(
      '{',
      optional(seq($.object_pair, repeat(seq(';', $.object_pair)))),
      '}',
    ),
    // Property names are UNQUOTED in literal syntax — `{a: 1}`, not `{"a": 1}`
    // — and pairs are separated by ';', not ','. The notation resembles JSON
    // but is not JSON.
    object_pair: $ => seq(field('key', $.identifier), ':', field('value', $._expression)),

    local_variable:        $ => token(seq('$', /[A-Za-z0-9_]+/)),
    interprocess_variable: $ => token(seq('<>', /[A-Za-z_][A-Za-z0-9_]*/)),
    identifier:            $ => /[A-Za-z_][A-Za-z0-9_]*/,

    number: $ => /\d+(\.\d+)?([eE][-+]?\d+)?/,
    string: $ => token(seq('"', repeat(choice(/[^"\\\n]/, /\\./)), '"')),

    _type: $ => choice($.identifier, seq('cs', '.', $.identifier), seq('4D', '.', $.identifier)),

    attributes_header: $ => token(seq('//', /\s*/, '%attributes', /[^\n]*/)),
    line_continuation: $ => token(seq('\\', /[ \t\r]*/, '\n')),
    line_comment:      $ => token(seq('//', /[^\n]*/)),
    block_comment:     $ => token(seq('/*', /[^*]*\*+([^/*][^*]*\*+)*/, '/')),
  },
});
