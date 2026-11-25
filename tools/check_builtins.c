// Verifies the invariant src/builtins.h promises: the table is ordered by
// fourd_stricmp, ascending, with no neighbours equal.
//
// This matters because fourd_builtin_kind() and is_builtin_prefix() both do a
// binary search. A table that is merely *almost* sorted does not fail loudly --
// it silently stops finding names. The header as shipped in 21 R4 left 401 of
// its own 3944 entries unreachable, which showed up as whole families of
// multi-word builtins never matching in the scanner.
//
//   cc -std=c11 -Wno-unused-function -Isrc -o /tmp/check tools/check_builtins.c
//   /tmp/check src/builtins.h
//
// Exit status 0 when every row is ordered and reachable, 1 otherwise.

#include <stdio.h>

#include "builtins.h"

int main(int argc, char **argv) {
  (void)argv;
  (void)argc;

  int failures = 0;

  for (size_t i = 1; i < FOURD_BUILTIN_COUNT; i++) {
    int order = fourd_stricmp(FOURD_BUILTINS[i - 1].name, FOURD_BUILTINS[i].name);
    if (order >= 0) {
      // Names are compared byte-wise, so report both neighbours: the pair is
      // what a maintainer needs to see, not just one row.
      fprintf(stderr, "error: not ascending at row %zu: \"%s\" then \"%s\"\n",
              i, FOURD_BUILTINS[i - 1].name, FOURD_BUILTINS[i].name);
      if (++failures >= 10) {
        fprintf(stderr, "error: stopping after 10 ordering failures\n");
        return 1;
      }
    }
  }

  // Ordering alone is not the goal; being findable is. Probe every row the way
  // the scanner will.
  size_t unreachable = 0;
  for (size_t i = 0; i < FOURD_BUILTIN_COUNT; i++) {
    const char *name = FOURD_BUILTINS[i].name;
    if (fourd_builtin_kind(name) != FOURD_BUILTINS[i].kind) {
      fprintf(stderr, "error: binary search cannot find its own row %zu: \"%s\"\n", i, name);
      unreachable++;
    }
  }

  if (failures || unreachable) {
    fprintf(stderr, "error: %d ordering failures, %zu unreachable rows of %zu\n",
            failures, unreachable, FOURD_BUILTIN_COUNT);
    return 1;
  }

  printf("%zu builtins, ordered and reachable, max words %d\n",
         FOURD_BUILTIN_COUNT, FOURD_MAX_BUILTIN_WORDS);
  return 0;
}
