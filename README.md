# tree-sitter-fourd

A tree-sitter grammar for the 4D programming language, targeting **4D 21 R4**.

This document records what we know about 4D's syntax, how the parser is built,
why it is built that way, and — at length — what it does not handle.

**Epistemic note.** Sections marked **[verified]** are confirmed against 4D's
official documentation or blog. Sections marked **[reported]** come from a 4D
developer's direct knowledge. Sections marked **[unverified]** are inferred and
should be confirmed against a real 21 R4 install before you rely on them.
Sections marked **[corpus]** are demonstrated by production `.4dm` source that
the parser is tested against — the strongest evidence of the three, since it
shows what 4D actually accepts rather than what the documentation says. This
distinction is kept deliberately visible; several early design decisions in this
project were wrong because an assumption went unmarked.

---

## Table of contents

1. [Why 4D is hard to parse](#1-why-4d-is-hard-to-parse)
2. [The 4D language, as far as we know it](#2-the-4d-language-as-far-as-we-know-it)
3. [Architecture](#3-architecture)
4. [Implementation walkthrough](#4-implementation-walkthrough)
5. [Limitations](#5-limitations)
6. [Building and testing](#6-building-and-testing)
7. [Resolved questions](#7-resolved-questions)

---

## 1. Why 4D is hard to parse

4D is a relational database IDE with a bundled language dating to 1984. Four
decades of backward compatibility have produced a language that violates most of
the assumptions a parser generator makes:

| Assumption | 4D reality |
|---|---|
| Identifiers have no spaces | `SET WINDOW TITLE`, `Current date`, `Is text` |
| One name per construct | Every builtin has an English and a French name |
| One meaning per sigil | `:` has nine distinct meanings; `[` has five |
| Blocks have explicit ends | Function bodies and `Case of` branches end implicitly |
| Statements end at a token | Newline terminates; `;` separates arguments |
| One language per file | `Begin SQL` blocks embed a second language |

Any one of these is manageable. Together they mean a naïve context-free lexer
cannot get off the ground. The design that follows exists almost entirely to
address this table.

---

## 2. The 4D language, as far as we know it

### 2.1 Source files and tokenization **[verified]**

Modern 4D projects store each method and class as a `.4dm` text file. Two facts
about that format drive the entire parser design.

**First: builtins carry numeric tokens.** Per 4D's blog, a command name is
followed by `:C` and the command ID, a constant by `:K` and the constant ID, a
table by `:` and the table ID, and a field by `:` and the field ID:

```4d
ALERT:C41("hello")
$type:=Is text:K8:3
$name:=[Employees:1]LastName:2
```

The suffix makes each builtin self-delimiting. `Current date:C33` cannot be
confused with an identifier `Current` followed by `date`, because the token
boundary is explicit.

**Second: source is stored in English.** All source is saved in English in the
`.4dm` files even if the developer works in the French version. The method
editor translates on open. So a parser that reads `.4dm` files does not need a
French keyword table at all.

**But tokenization is optional.** 4D can be configured to save source without
tokens for readability in version control. Untokenized source loses both
guarantees, which is why the parser carries a fallback path (§4.2).

### 2.2 File header **[verified]**

A metadata comment may lead the file:

```4d
// %attributes = {"lang":"en","invisible":true,"folder":"Web3"}
```

The `lang` attribute records the export language and blocks import into an
application using a different one.

### 2.3 Comments **[verified]**

```4d
// line comment
/* block comment */
```

### 2.4 Variables and scope sigils **[verified]**

| Form | Meaning |
|---|---|
| `$name` | Local variable |
| `$1`, `$2`, … | Positional parameters |
| `<>name` | Interprocess variable |
| `name` | Process variable — **no sigil** |
| `This.name` | Current instance member |
| `Form.name` | Form object member |
| `cs.ClassName` | User class namespace |
| `4D.ClassName` | Built-in class namespace |

The unsigilled process variable is a recurring hazard: a variable may be named
`local`, `server`, or `defer`, colliding with keywords.

**Reserved system variables [reported].** 4D predefines a set of unsigilled,
unshadowable process variables — `OK`, `Error`, `Document` and others. They are
a third builtin namespace alongside commands and constants, and some are
multi-word, so they are table-driven rather than a keyword list.

### 2.5 Literals **[verified / reported]**

| Form | Type | Notes |
|---|---|---|
| `"text"` | Text | |
| `123`, `1.5`, `1e3` | Number | Exponent form covers the Real range, ±1.7e±308 |
| `0xFFFFFFFF` | Number | Hex, `0x`/`0X` prefix — used as a literal in official command docs. No binary or octal form |
| `!2004-09-29!` | Date | ISO `!YYYY-MM-DD!` is the standard form |
| `!00-00-00!` | Date | **The null date.** There is no `!!` shorthand |
| `!12/04/98!` | Date | Two-digit years accepted for compatibility |
| `?00:00:00?` | Time | **[reported]** delimiter pair, both ends `?` |
| `[1;2;3]` | Collection | `;` separates elements |
| `{a: 1; b: 2}` | Object | Keys **unquoted**, pairs separated by `;` |

**Dates.** A date literal is enclosed in exclamation marks and structured in ISO
format. The hyphen is standard, but 4D accepts two-digit years for compatibility
— assumed 20th or 21st century by comparison against 30, adjustable with
`SET DEFAULT CENTURY` — and under *Use regional system settings* the system's
own delimiter applies, commonly a slash. The Code Editor offers a shortcut for
the null date (type `!`, press Enter), which expands to the full `!00-00-00!`.

**Objects.** An object literal is a semicolon-separated list of property/value
pairs in curly braces. The notation *resembles* JSON but is not JSON: property
names are unquoted and the separator is `;`, not `,`.

```4d
$o2:={a: "foo"; b: 42; c: {}; d: ($toto) ? True : False}
```

The collection literal is documented: the `[]` operator creates a collection
literal, a list of zero or more expressions enclosed in square brackets.

### 2.6 Operators **[verified / reported]**

**Assignment.** `:=` is assignment; 4D deliberately avoided `=` to sidestep the
`==`/`===` confusion of other languages. Compound forms `+=`, `-=`, `*=`, `/=`
exist.

**Comparison.** `=` equal, `#` **not equal**, `<`, `>`, `<=`, `>=`.
Note that `#` is not a comment.

**Logical.** `&` and, `|` or.

**Short-circuit.** `&&` and `||`. 4D supports the truthy/falsy concept from
JavaScript, which these operators use. They follow C precedence, sitting *below*
their bitwise counterparts — `$a | $b && $c` groups as `($a | $b) && $c`.
Longest-match lexing is what keeps `&&` clear of `&`.

**Arithmetic.** `+`, `-`, `*`, `/`, `%`, and `\` for **integer division**
**[reported]**. The backslash doubles as the line-continuation marker (§2.7),
which is the single most consequential operator overload in the language.

**Ternary.** 4D has exactly one ternary operator, the conditional `a ? b : c`.

**Bitwise and shift.** C-style semantics, including `<<` and `>>`. **[reported]**
The `?`-prefixed family (`?+`, `?-`, and siblings) is **bitwise**, not
time-related — an early draft of this parser had that wrong.

**Pointers.** `->` is both a prefix (pointer creation, `->[Table]Field`) and a
postfix (dereference, `$p->`).

**Character position.** `[[n]]` is a character-position operator: `$text[[3]]`.
**[reported]**

**Legacy array element.** `$arr{5}` uses braces.

**Marker parameters [verified / corpus].** Some command parameters are not
expressions at all: the trailing `*` (`Lowercase($c; *)`) and the `>` / `<`
direction markers of commands like `ORDER BY`. They are bare tokens in argument
position, so an argument list is `choice(expression, '*', '>', '<')`, not a
list of expressions.

### 2.7 Statement structure **[verified]**

- **Newline terminates a statement.**
- **`;` separates arguments**, not statements — `ALERT("a";"b")`.
- **Line continuation with a trailing `\` exists in 21 R4 [reported].** Because
  `\` is simultaneously integer division, the two are told apart by what
  follows: a continuation has nothing but whitespace to end of line.

### 2.8 Control flow **[verified]**

```4d
If (cond)          Case of              While (cond)     Repeat
   ...                : (cond)             ...              ...
Else                   ...               End while       Until (cond)
   ...                : (cond)
End if                 ...              For ($i;1;10)    For each ($x;$col)
                     Else                  ...              ...
                       ...               End for         End for each
                     End case

Try                    Try(expression)     // single-line form
   ...
Catch
   ...
End try
```

`Case of` branch labels are a bare `:` followed by a parenthesized condition.
Branches are **implicitly terminated** by the next `:`, `Else`, or `End case`.

**The condition parentheses are not statement syntax [corpus].** `If`, `While`,
`Until`, and `Case of` labels take an ordinary expression. The customary parens
are just a parenthesized expression, and production code freely writes
conditions whose parens do not wrap the whole thing:

```4d
If ($char=" ") | ($char="_") | Match regex:C1019("\\d"; $char)
```

The condition is the entire `|` chain. A grammar that hard-codes
`'If' '(' expr ')'` truncates the condition at the first `)` and errors on the
`|` — this was a real bug in this parser (§4.9). `For` and `For each` are the
exception: their parentheses genuinely delimit a `;`-separated header and stay
in the statement rule.

### 2.9 Error handling and jumps **[verified]**

`throw` arrived in **v20 R2**; thrown errors behave like any other 4D error and
can carry an object payload including a `deferred` flag.

`Try...Catch...End try` evaluates a block, in contrast to `Try(expression)`
which evaluates a single-line expression.

`defer` is a **21 R4** feature and is **call-shaped, not a block**:
`defer(DOM CLOSE XML($root))`. It accepts **any expression [reported]**, not
merely a command or method call.

Also present: `return`, `break`, `continue`.

**A useful design property [reported]:** the newer keywords are deliberately
short and lowercase, keeping them clear of the legacy builtin namespace, which
is `Capitalized` or `ALL CAPS`. Case-sensitive matching on the lowercase set is
therefore nearly collision-free against builtins — though not against
unsigilled process variables.

### 2.10 Classes **[verified]**

```4d
// Class: MyClass
Class extends ParentClass

property itemList : Collection:=[]

shared singleton Class constructor($param : Text)
   This.value:=$param

exposed onHTTPGet Function getInfo() : 4D.OutgoingMessage
   return ...

server Function get user() : cs.UsersEntity
   return ds.Users.get(...)
```

**The critical structural fact:** there is no ending keyword for function code.
4D detects the end of a function's code by the next `Function` keyword or the
end of the class file.

**Modifiers.**

| Modifier | Applies to | Meaning |
|---|---|---|
| `shared` | class, function | Shared class / auto `use`…`end use` |
| `session` | class | One instance per session |
| `singleton` | class | Single instance |
| `exposed` | function, alias | Callable by remote/REST request |
| `onHTTPGet` | function | Additionally callable via HTTP GET |
| `local` | function | Executes on the client |
| `server` | function | Always executes on the server |

Also: `Class extends <superclass>`, `property`, `Alias`, `Super`, and computed
attributes via `Function get` / `Function set`.

`property` and `var` share one declaration shape **[verified]**: several names
may share a type (`property a; b : Text`, `var $x; $y; z : Integer` — note the
unsigilled process variable in the list), the type may be omitted (Variant),
and declaration and initialization combine on one line, with or without the
type: `var $t : Text:="hello"`, `var $n:=42`, `property itemList : Collection:=[]`.

Method files declare parameters with the `#DECLARE` directive. The return is
introduced by `->` (naming an output variable) or by a bare `: Type` that pairs
with a `return` statement — both forms also exist on `Function`:

```4d
#DECLARE($in : Text) -> $o : Object
#DECLARE($in : Text) : Object
```

**Variadic parameters (v20 R3+) [verified].** An ellipsis in last position
declares a variable number of trailing parameters. It is **nameless**, takes an
optional type, and the extra arguments are reached with the `${N}` indirection
syntax, where N is a full expression:

```4d
#DECLARE(... : Real) : Real
For ($i; 1; Count parameters)
   $total+=${$i}
End for
```

In the grammar: `parameter` is either `$name : Type` or `... : Type`;
`${N}` is a `parameter_indirection` primary, whose `${` token cannot collide
with `local_variable` because that token requires an alphanumeric after `$`.
Restricting `...` to last position is left to a linter (§5.6).

### 2.11 Embedded SQL **[verified / reported]**

```4d
Begin SQL
   SELECT name FROM employees WHERE id = :$empID
End SQL
```

The block body is SQL, with 4D interpolations (`:$var`, `<<$var>>`,
`[Table]Field`) embedded in it. `SQL EXECUTE("...")` passes SQL as a string
instead.

**`End SQL` must be alone on its line [reported]** — not even a trailing comment
is permitted. This turns out to be a gift rather than a restriction: see §4.8.

---

## 3. Architecture

Four files, each with a distinct job:

```
grammar.js        Structure: statements, expressions, precedence, classes
src/scanner.c     Context-sensitive lexing — everything the CFG cannot decide
src/builtins.h    Generated lookup table of command and constant names
tools/generate_builtins.py   Emits builtins.h from scraped name lists
```

### 3.1 The organising idea: `valid_symbols`

Almost every ambiguity in 4D is **context-sensitive, not lexical**. `[[` is a
character reference in one position and two collection literals in another. `?`
opens a time literal in one position and a ternary in another.

Tree-sitter's external scanner receives a `valid_symbols[]` array naming exactly
which tokens the *parser* can accept at the current position. That converts an
unresolvable lexical question into a trivial one:

```c
if (valid_symbols[CHAR_REF_OPEN] && lexer->lookahead == '[') { ... }
```

If the parser is at expression start, it does not accept `CHAR_REF_OPEN`, so the
scanner never claims `[[` and the nested collection literal parses correctly. No
backtracking, no heuristics, no semantic pass.

A second property makes this cheap: **returning `false` from the scanner resets
the lexer to the token start.** The scanner can advance freely to look ahead and
bail out at no cost. Combined with `mark_end()`, which fixes where the token
actually ends regardless of how far lookahead went, this covers every case below.

### 3.2 External token catalogue

| Token | Width | Why it cannot live in the grammar |
|---|---|---|
| `_terminator` | 1 | Newline is significant only where the parser accepts it |
| `_function_start` | 0 | Confirms a modifier chain ends in `Function`/`Class constructor` |
| `char_ref_open` / `char_ref_close` | 2 | `[[` is position-dependent |
| `time_literal` | var | `?…?` collides with ternary and the bitwise `?` family |
| `date_literal` | var | `!…!` needs internal structure validation |
| `sql_content` | var | Raw scan to a terminator line |
| `command_name` | var | Multi-word, longest-match against a table |
| `constant_name` | var | Same, different highlight class |

---

## 4. Implementation walkthrough

### 4.1 Multi-word builtins, tokenized

The happy path costs two regexes:

```js
command:  $ => token(/[A-Za-z_][A-Za-z0-9_ ]*:C\d+/),
constant: $ => token(/[A-Za-z_][A-Za-z0-9_ ]*:K\d+:\d+/),
```

These absorb roughly 1300 commands and several thousand constants, every
embedded space, and the entire French/English question — because tokenized
source stores builtins in English with a numeric suffix. Longest-match resolves
`Current date:C33` without any table lookup.

### 4.2 Multi-word builtins, untokenized

When tokens are disabled the suffix is gone and `Current date` is genuinely
ambiguous with `Current` + `date`. The scanner walks words greedily, consulting
a sorted table after each word boundary and calling `mark_end()` on every prefix
that matches. The last mark wins:

```
Current date + 1
^^^^^^^                  "Current"      → no match, but a prefix exists
^^^^^^^^^^^^             "Current date" → match, mark_end here
             ^           " + 1"         → not a word, stop
```

**All three builtin namespaces share one table.** In untokenized form commands,
constants and system variables are lexically identical — same character class,
same embedded spaces, same expression positions. Separate tables would mean
three binary searches per word boundary; one table with a kind mask costs one.

**The namespaces are disjoint [reported]:** no 4D name is both a command and a
constant. The generator hard-errors if a regenerated table ever violates that,
rather than silently picking a winner, because the scanner assumes exactly one
kind bit is set.

The kind is masked against `valid_symbols` before acceptance, so a constant-only
name will not match where the parser cannot accept a constant.

Maximum word counts are confirmed for 21 R4: **6 for commands, 7 for
constants**. `FOURD_MAX_BUILTIN_WORDS` is 7, and the generator warns if a
regenerated table exceeds it.

An `is_builtin_prefix()` check provides early bailout: once nothing in the table
extends the accumulated prefix, further words cannot help, and ordinary
identifiers stop dragging the lexer forward.

### 4.3 Implicit block termination

Function bodies have no `End function`. They end at the next `Function`,
`Class constructor`, or EOF. Expressed directly:

```js
function_declaration: $ => seq(
  $._function_start,
  repeat(field('modifier', $.modifier)),
  ...
  field('body', repeat($._statement)),
),
```

`repeat($._statement)` stops when the lookahead is `_function_start`. That works
only because `_function_start` is unambiguous — and it is not, on its own,
because `local`, `server`, `shared` and friends are legal process variable names.
So the scanner emits the zero-width marker **only after confirming** the word
chain terminates in `Function` or `Class constructor`:

```
shared singleton Class constructor()
^ marker emitted here, zero width, after lookahead confirms "Class constructor"

local:=5
^ no marker: "local" is followed by ":=", so this is an assignment
```

`Case of` branches use the same shape but need no scanner help: no statement can
begin with `:`, and `:=` out-lexes a bare colon, so plain LR handles it.

### 4.4 The colon, nine ways

| Context | Form |
|---|---|
| Assignment | `$x := 1` |
| Command token | `ALERT:C41` |
| Constant token | `Is text:K8:3` |
| Table / field ID | `[Employees:1]Name:2` |
| Type annotation | `$x : Text` |
| Case label | `: ($x=1)` |
| Ternary | `a ? b : c` |
| Object literal | `{key: value}` |
| Return type | `Function f() : Text` |

Only `:=` and the `:C`/`:K` suffixes are lexed atomically. Everything else is a
single generic `:` token disambiguated by parser context. Attempting to lex nine
variants produces a lexer that cannot be reasoned about.

### 4.5 The bracket problem

`[` carries five meanings: table reference, table reference with IDs, collection
literal, collection index, and the first half of `[[`.

The nasty case is `[[`:

```4d
$c:=[[1;2];[3;4]]     // collection of collections — expression start
$ch:=$text[[3]]       // character reference — postfix position
```

Byte-identical prefixes. Lexing `[[` as one token silently destroys the first
case. The scanner gates it on `valid_symbols[CHAR_REF_OPEN]`, which is true only
where a postfix operator is legal.

`{` carries two: object literal at expression start, legacy array element in
postfix position. Same resolution, handled by `prec.left` on the postfix rules.

### 4.6 The question mark, three ways

`?` opens a time literal, introduces the ternary, and prefixes the bitwise
family. **Space is the tiebreaker [reported]:** a time literal has a digit
immediately after `?`, a ternary has whitespace. The scanner encodes exactly
that:

```c
adv(l);                                     // '?'
if (!iswdigit(l->lookahead)) return false;  // "? " or "?+" → not a literal
```

### 4.7 Significant newlines and line continuation

Newline terminates a statement but must be ignored inside a bracketed
expression. Rather than tracking bracket depth in scanner state, the scanner
asks the parser: if `valid_symbols[TERMINATOR]` is false, the newline is
consumed as whitespace instead. Depth tracking falls out of the LR state for
free.

### 4.8 SQL as a language injection

`sql_content` is scanned raw up to the terminator line, then handed to
tree-sitter-sql.

Because 4D requires `End SQL` to be alone on its line, the scanner enforces that
strictly — after matching the two words it verifies nothing but whitespace
remains. Strictness here buys robustness rather than costing it: SQL content
containing the literal text `End SQL` inside a string or a mid-line comment
cannot false-terminate the block.

```scm
(sql_block
  body: (sql_content) @injection.content
  (#set! injection.language "sql"))
```

See §5.4 for why this is currently disabled by default.

### 4.9 Conditions are bare expressions

An earlier version wrote `'If' '(' expr ')'`, mirroring the documentation's
`If(Boolean_Expression)`. The first real-world method broke it: in
`If ($a=1) | ($b=2)` the parser committed the `(` as statement syntax, took
`($a=1)` as the whole condition, and errored at the `|`. The rules are now

```js
if_statement: $ => seq('If', field('condition', $._expression), $._terminator, ...)
```

and likewise `While`, `Until`, and `case_branch`. The parenthesized form still
parses — the parens are simply a parenthesized-expression primary.

The same corpus file surfaced the marker parameters (§2.6):
`Lowercase:C14($char; *)` errored on the bare `*`. Argument lists are now

```js
_argument: $ => choice($._expression, '*', '>', '<'),
```

which stays LR(1)-clean because none of the three markers can begin an
expression.

**A debugging lesson worth recording:** the ERROR node's start position is not
where parsing failed. When recovery hits a fault it pops unfinished enclosing
frames off the stack, so the single `|` fault on an `If` line inside a
`For each` produced one ERROR spanning from the `For each` header to EOF, with
the header's already-parsed children dumped inside as orphans. When reading
corpus output, locate the first fault by finding the last *well-formed* child
inside the ERROR, not by the ERROR's start — and fix that one fault before
believing anything the tree says after it.

---

## 5. Limitations

### 5.1 Ternary versus time literal is genuinely ambiguous

```4d
$x:=$flag?12:00:00?$y
```

Both a time literal and a ternary are valid readings, and no amount of lookahead
distinguishes them — the ambiguity is in the language, not the parser. We prefer
the time literal. Real code separates ternary operands with spaces, so the
failure is theoretical, but it is a genuine incorrect parse when it occurs.

**Workaround:** put spaces around ternary `?` and `:`.

### 5.2 Untokenized constants are the weakest link

Constant names are short and generic (`Is text`, `On Load`). Unlike commands
they are never followed by `(`, so there is no syntactic confirmation. A user
method or process variable can genuinely collide, and the parser will
mis-highlight it as a constant.

**Workaround:** keep tokenization enabled, which bypasses the table entirely. If
you must parse untokenized source, prune rarely-used theme constants from the
generated table rather than complicating the scanner.

### 5.3 `field_reference` is one atomic token

`[Employees:1]Name:2` is matched as a single token so it outlengths the
collection-literal rule. This breaks on whitespace inside the brackets
(`[ Employees ]Name`). If your corpus contains any, demote it to a parser rule
gated on `valid_symbols`, following the `char_ref_open` pattern.

### 5.4 SQL injection is imperfect

4D interpolates its own syntax inside SQL blocks (`:$var`, `<<$var>>`,
`[Table]Field`). tree-sitter-sql does not know these and will produce `ERROR`
nodes throughout the injected tree.

**Current behaviour:** injection is available but flat highlighting of
`sql_content` is the recommended default. A full fix requires carving the
interpolations into separate nodes and injecting only the gaps via multiple
`@injection.content` captures.

### 5.5 (retired) `Try` needs no conflict declaration

Kept as a record of a corrected error. This section previously claimed the
`Try(...)` / `Try` block ambiguity was resolved by a declared GLR conflict.
It is not ambiguous at all: `try_statement` requires a `_terminator` immediately
after `Try` and `try_expression` requires `(`, so one token of lookahead
separates them. Tree-sitter confirms this — declaring the conflict produces
`Warning: unnecessary conflicts`. The declaration has been removed.

### 5.6 Semantics are out of scope

The grammar is deliberately permissive about modifiers: it accepts
`session local Function` even though that combination is meaningless. Which
modifier is legal where belongs in a linter. Grammars that enforce semantics
become brittle when the language adds a case.

### 5.7 French source is not supported

`.4dm` files store English. A French install with *Use regional system settings*
enabled, formulas stored in form JSON, or legacy `.4db` exports may contain
French. Supporting these means a second keyword table and a second builtin
table — a substantial addition, not a small one.

### 5.8 `return` inside `Formula()` is not handled

4D permits `Formula(return This.ob1.age+10)` — a `return` in expression
position, with no statement terminator. `jump_statement` requires a
`_terminator`, so this parses as an error. Fixing it means admitting `return`
as an expression form, which risks ambiguity with the statement form.

### 5.9 Line continuation defeats naïve line-based tooling

A trailing `\` joins lines, so anything downstream that assumes one statement
per physical line — grep-based linters, diff hunks, `#line`-style mapping — will
misread continued statements. The parser handles it correctly; consumers of the
tree may not.

### 5.10 Error recovery is untuned

`_statement` has no permissive catch-all alternative yet. Adding an
`unknown_line` fallback would convert many `ERROR` nodes into something a
highlighter can work with, at the cost of masking real grammar gaps during
development. Add it once the corpus error rate has plateaued.

---

## 6. Building and testing

```bash
python3 tools/generate_builtins.py commands.txt constants.txt > src/builtins.h
tree-sitter generate
tree-sitter build
tree-sitter test
```

### The corpus harness matters more than the test suite

Parse your entire real `.4dm` tree and count `ERROR` nodes. That number, not the
grammar's apparent plausibility, should drive what you fix next:

```bash
tree-sitter parse -q --stat 'path/to/project/**/*.4dm'
```

Work the highest-frequency error site first. Most grammar work on a language
this irregular is discovering constructs you did not know existed.

Enable `fourd_builtins_sorted()` in debug builds. A mis-sorted table makes the
binary search miss entries silently, which presents as random builtins failing
to highlight — an unpleasant thing to debug from symptoms.

---

## 7. Resolved questions

Every question raised during design has since been answered — by a 4D developer
**[reported]** or by production source **[corpus]**. Recorded here because each
one changed the implementation.

| Question | Answer | Consequence |
|---|---|---|
| Does 21 R4 support `\` line continuation? | Yes — and `\` is also integer division | Scanner distinguishes by end-of-line context (§4.7) |
| Is any name both a command and a constant? | No; namespaces are disjoint | Generator hard-errors on overlap; scanner assumes one kind bit |
| Are there other builtin namespaces? | Yes — reserved system variables (`OK`, `Error`, `Document`) | Third kind bit and external token added |
| What is the maximum builtin word count? | 6 for commands, 7 for constants | `FOURD_MAX_BUILTIN_WORDS` = 7 |
| May anything follow `End SQL` on its line? | No, not even a comment | Strict terminator check; prevents false termination |
| Does `defer` accept arbitrary expressions? | Yes | `jump_statement` keeps the full `$._expression` |
| Are the parens in `If (…)` statement syntax? | No — the condition is a plain expression; `If ($a) \| ($b)` is legal **[corpus]** | `If`/`While`/`Until`/case labels take a bare `$._expression` (§4.9) |
| Is every argument an expression? | No — `*`, `>`, `<` marker parameters exist **[corpus]** | `_argument` admits the marker tokens (§2.6) |
| Is the variadic `...` a named parameter? | No — it is nameless, with optional type; extras are read via `${N}` **[verified]** | `parameter` split into named / variadic shapes; `parameter_indirection` added (§2.10) |

No open questions remain. New ones should be added here rather than resolved
silently — the tagging convention in this document exists because untracked
assumptions caused every early design error in the project.

## Provenance

Language facts in §2 are drawn from 4D's official documentation at
`developer.4d.com` and the 4D company blog, supplemented by a 4D developer's
direct knowledge where marked **[reported]**. No existing tree-sitter grammar
for 4D was found during research; prior editor support exists as TextMate-style
grammars, which are a useful source for builtin name lists but not for
structure.
