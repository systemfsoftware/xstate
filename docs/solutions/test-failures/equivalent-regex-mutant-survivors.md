---
title: A regex mutant that survives the release gate may be equivalent; prove it by enumeration, then delete the branch it mutates
date: 2026-10-09
category: test-failures
module: packages/xstate
problem_type: test_failure
component: testing_framework
symptoms:
  - "The release gate's mutation report lists a `Regex` mutant as `Survived` in a parser the conformance spec covers, and no generated input turns it red"
  - "The report lists a `StringLiteral` mutant as `NoCoverage` on a destructuring default such as `([, segment = ''])`"
root_cause: missing_test
resolution_type: test_fix
severity: medium
tags: [mutation-testing, stryker, regex, equivalent-mutant, state-id, conformance-model]
---

# A regex mutant that survives the release gate may be equivalent; prove it by enumeration, then delete the branch it mutates

## Problem

The release gate holds an enrolled file's mutated set at a 100% kill score (CONST-T3). After the state-id parser behind `toStatePath` was enrolled, the gate reported three `Survived` regex mutants and one `NoCoverage` string literal. Two survivors only needed new model inputs. The third survivor was equivalent, so no input could kill it. The `NoCoverage` literal was a default that no input could reach.

## Symptoms

- `Survived`, `\\$` -> `\\` in the segment regex: the `\\$` alternative after `\\[\s\S]` in `(?:\\[\s\S]|\\$|[^.\\])*`.
- `Survived`, `\\[\s\S]` -> `\\[\S\S]` and `\\([\s\S])` -> `\\([\S\S])`: the model never drew an id with a backslash before whitespace.
- `NoCoverage`, `''` in `([, segment = '']) =>`: capture group 1 is `(...*)`, which takes part in every match, so the default never runs.

## What Didn't Work

- Adding model rows for the `\\$` mutant. Inside a starred alternation, a backslash followed by anything is taken by `\\[\s\S]`. `\\$` is tried only for a backslash at the end of input, where `\\` matches exactly the same text, and nothing follows the group, so the engine never backtracks into it. No input separates the two regexes.

## Solution

1. Separate killable survivors from equivalent ones with an executable check, not argument alone. Generate each mutant with the instrumenter's own rules (`mutateRegexPattern` in `@systemfsoftware/stryker-js-instrumenter`: anchor removal, class negation, `\s`/`\S` swap, quantifier removal) and compare every mutant's split with the original's over every string up to length 7 on a small alphabet that covers each character class the pattern names (`a`, `.`, `\`, space: 21,845 strings). A mutant that agrees on every input is a candidate equivalent; a mutant that differs gives the shortest input that kills it.
2. For each killable survivor, add the input class to the conformance model, not a hand-picked example. Here the model's state names gained whitespace and a trailing backslash, each command draws an id escape style (`dot-and-backslash`, `every-character`, `bare-final-backslash`), and the ledger step fails any run that drew none of the new classes.
3. For the equivalent mutant and the unreachable default, delete the code they mutate (CONST-S4) rather than leave a mutant nobody can kill:

```ts
// before
const segmentAfterDot = /\.((?:\\[\s\S]|\\$|[^.\\])*)/g
Array.from(`.${stateId}`.matchAll(segmentAfterDot), ([, segment = '']) => segment.replace(escapedCharacter, '$1'))

// after
const dotAndSegment = /\.(?:\\[\s\S]|[^.\\])*\\?/g
Array.from(`.${stateId}`.matchAll(dotAndSegment), ([dotted]) => dotted.slice(1).replace(escapedCharacter, '$1'))
```

The bare final backslash is now one trailing `\\?`, whose quantifier-removal mutant the new rows kill. Run the same enumeration on the rewritten pattern: it must split every input like the original, and every one of its mutants must differ somewhere.

## Why This Works

An equivalent mutant has no killing input, so the only ways to reach a 100% score are to suppress it or to remove the code it mutates. Suppression is banned (CONST-T3). Rewriting the pattern so the redundant branch does not exist keeps the language identical and leaves only mutants that change it. The enumeration also checks the rewrite: the unmutated new pattern must agree with the old on every input.

## Prevention

- Before enrolling a file that holds a regex, run the enumeration over its patterns. Every mutant that agrees with the original on all inputs is a branch to delete before the gate sees it.
- Give the conformance model one input class per character class in the pattern. A class the model never draws leaves its `\s`/`\S` swap alive.
- A destructuring default on a capture group that always takes part in the match is dead code; take the whole match and slice instead.

## Related Issues

- Branch `xs/xstate-state-matching-survivors`, release gate run 37869702486 on `9857b0b3`.
