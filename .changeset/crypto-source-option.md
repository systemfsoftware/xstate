---
"@systemfsoftware/xstate": minor
---

`createActor` accepts a `crypto` option (`{ getRandomValues?, randomUUID? }`), the Web Crypto source of the session-id prefix for the system a root actor creates. Without it, every system still shares one prefix read once per process from `globalThis.crypto`. With it, that system builds its own prefix from the given methods and falls back to a time-and-`Math.random` prefix when neither works, so the fallback can be exercised without replacing `globalThis.crypto`. Actors that join a parent's system ignore the option.
