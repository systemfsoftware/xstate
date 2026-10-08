---
"@systemfsoftware/xstate": minor
---

`assertEvent` can now be called with the event types alone. It returns the assertion as a function: bind that function to a constant with an explicit assertion type, such as `const assertGreet: (event: AppEvent) => asserts event is Greet = assertEvent('greet')`. Calling `assertGreet(event)` then narrows `event` and throws the same error as `assertEvent(event, 'greet')` when the type does not match. TypeScript narrows only through an explicitly typed assertion function, so calling `assertEvent('greet')(event)` inline is a type error (TS2776). Calls of the form `assertEvent(event, types)` are unchanged.
