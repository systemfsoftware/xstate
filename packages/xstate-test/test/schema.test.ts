import { it } from '@systemfsoftware/vitest'
import { createMachine, type StandardSchemaV1, types } from '@systemfsoftware/xstate'
import { Effect } from 'effect'
import * as DateTime from 'effect/DateTime'
import { pipe } from 'effect/Function'
import * as Schema from 'effect/Schema'
import * as fc from 'fast-check'
import { describe } from 'vitest'
import * as z from 'zod'
import * as z3 from 'zod/v3'
import { eventsFromSchemas as eventsFromSchemasWithEffect } from '../src/effect-schema.js'
import {
  arbitraryFromSchema,
  eventsFromSchemas,
  fastCheckAdapter,
  mergeEventGenerators,
  propertyTest,
} from '../src/index.js'

enum NumericEnum {
  A,
  B,
}

enum MixedEnum {
  A = 0,
  B = 'b',
}

const sample = <T>(arbitrary: fc.Arbitrary<T>, numRuns = 20): T[] => fc.sample(arbitrary, { seed: 7, numRuns })

const epochDate = (milliseconds: number): Date => DateTime.toDate(DateTime.makeUnsafe(milliseconds))

const thrownMessage = (call: () => unknown): string => {
  try {
    call()
  } catch (error) {
    return String(error)
  }
  return 'no error was thrown'
}

type SchemaLike = { safeParse(value: unknown): { success: boolean } }

const parsesDrawnValues = (
  schema: SchemaLike,
  seed?: number,
): { readonly failed: boolean; readonly runs: number } => {
  const details = fc.check(
    fc.property(
      arbitraryFromSchema(schema),
      (value) => schema.safeParse(value).success,
    ),
    seed === undefined ? { numRuns: 200 } : { numRuns: 200, seed },
  )
  return { failed: details.failed, runs: details.numRuns }
}

describe('eventsFromSchemas with Zod', () => {
  const zodMachine = createMachine({
    schemas: {
      context: types<{ count: number }>(),
      events: {
        INC: z.object({ value: z.number().int() }),
        SET: z.object({
          label: z.string(),
          mode: z.enum(['a', 'b']),
          tags: z.array(z.string()),
          note: z.string().optional(),
          amount: z.union([z.number(), z.literal('max')]),
        }),
      },
    },
    context: { count: 0 },
    on: {
      INC: ({ context, event }) => ({
        context: { count: context.count + event.value },
      }),
      SET: () => ({}),
      ...({ RESET: () => ({ context: { count: 0 } }) } as {}),
    },
  })

  it('derives generators for each declared event schema', function*({ expect }) {
    const events = eventsFromSchemas(zodMachine)

    const inc = sample(events.INC as fc.Arbitrary<{ value: number }>)
    const set = sample(events.SET as fc.Arbitrary<Record<string, unknown>>)
    const notes = sample(events.SET as fc.Arbitrary<Record<string, unknown>>, 50).map((value) => 'note' in value)

    yield* expect({
      keys: Object.keys(events).sort(),
      incIntegers: inc.every((value) => Number.isInteger(value.value)),
      incCarriesType: inc.some((value) => 'type' in value),
      setModes: [...new Set(set.map((value) => value['mode']))].every((mode) => mode === 'a' || mode === 'b'),
      setLabelsAreStrings: set.every((value) => typeof value['label'] === 'string'),
      setTagsAreArrays: set.every((value) => Array.isArray(value['tags'])),
      setAmountsAreNumberOrMax: set.every(
        (value) => typeof value['amount'] === 'number' || value['amount'] === 'max',
      ),
      notesIncludeAbsent: notes.includes(false),
    }).toEqual({
      keys: ['INC', 'RESET', 'SET'],
      incIntegers: true,
      incCarriesType: false,
      setModes: true,
      setLabelsAreStrings: true,
      setTagsAreArrays: true,
      setAmountsAreNumberOrMax: true,
      notesIncludeAbsent: true,
    })
  })

  it('generates empty payloads for events without a schema by default', function*({ expect }) {
    const events = eventsFromSchemas(zodMachine)
    const resetArbitrary = (events as Record<string, fc.Arbitrary<unknown>>)[
      'RESET'
    ]
    if (resetArbitrary === undefined) {
      throw new Error('expected a RESET generator')
    }
    yield* expect(sample(resetArbitrary, 1)).toEqual([{}])
  })

  it('skips events without a schema when configured', function*({ expect }) {
    const events = eventsFromSchemas(zodMachine, {
      eventsWithoutSchema: 'skip',
    })
    yield* expect(Object.keys(events).sort()).toEqual(['INC', 'SET'])
  })

  it('strips a declared `type` field from generated payloads', function*({ expect }) {
    const machine = createMachine({
      schemas: {
        events: { PING: z.object({ type: z.literal('PING'), id: z.string() }) },
      },
      on: { PING: () => ({}) },
    })

    const values = sample(
      eventsFromSchemas(machine).PING as fc.Arbitrary<Record<string, unknown>>,
    )

    yield* expect({
      count: values.length,
      anyCarriesType: values.some((value) => 'type' in value),
      allIdsAreStrings: values.every((value) => typeof value['id'] === 'string'),
    }).toEqual({ count: 20, anyCarriesType: false, allIdsAreStrings: true })
  })

  it('throws a descriptive error for a non-object event payload', function*({ expect }) {
    const machine = createMachine({
      schemas: { events: { PING: z.number() } },
      on: { PING: () => ({}) },
    })

    const message = thrownMessage(() =>
      sample(
        eventsFromSchemas(machine)['PING'] as fc.Arbitrary<Record<string, unknown>>,
      )
    )

    yield* expect({ message }).toEqual({
      message: expect.stringMatching(
        /^Error: Property event "PING" generated a non-object payload \(.+\)\. Event payloads must be plain objects; use a `resolve` function to map generated values onto an event payload\.$/,
      ),
    })
  })

  it('supports Zod v3-shaped definitions', function*({ expect }) {
    const v3String = { _def: { typeName: 'ZodString' } }
    const v3Object = {
      _def: {
        typeName: 'ZodObject',
        shape: () => ({
          name: v3String,
          count: { _def: { typeName: 'ZodNumber', checks: [{ kind: 'int' }] } },
        }),
      },
    }

    const values = sample(
      arbitraryFromSchema(v3Object) as fc.Arbitrary<Record<string, unknown>>,
    )

    yield* expect({
      count: values.length,
      allNamesAreStrings: values.every((value) => typeof value['name'] === 'string'),
      allCountsAreIntegers: values.every((value) => Number.isInteger(value['count'])),
    }).toEqual({ count: 20, allNamesAreStrings: true, allCountsAreIntegers: true })
  })

  it('reports unsupported kinds with the schema path', function*({ expect }) {
    const machine = createMachine({
      schemas: { events: { GO: z.object({ when: z.promise(z.string()) }) } },
      on: { GO: () => ({}) },
    })

    const message = thrownMessage(() => eventsFromSchemas(machine))

    yield* expect(message).toEqual(
      "Error: [@xstate/test] Unsupported Zod schema kind 'promise' at 'GO.when'.",
    )
  })

  it('reports type-only schemas as underivable', function*({ expect }) {
    const machine = createMachine({
      schemas: { events: { GO: types<{ value: number }>() } },
      on: { GO: () => ({}) },
    })

    const message = thrownMessage(() => eventsFromSchemas(machine))

    yield* expect(message).toEqual(
      "Error: [@xstate/test] The schema at 'GO' is a type-only schema (`types<...>()`). Type-only declarations carry no runtime structure, so no generator can be derived. Declare a runtime schema (Zod (v3 and v4) and Effect Schema (via `@xstate/test/effect-schema`)) or pass an explicit generator.",
    )
  })

  it('uses a fallback converter when provided', function*({ expect }) {
    const machine = createMachine({
      schemas: { events: { GO: types<{ value: number }>() } },
      on: { GO: () => ({}) },
    })

    const events = eventsFromSchemas(machine, {
      fallback: () => fc.constant({ value: 1 }),
    })

    yield* expect(sample(events.GO as fc.Arbitrary<unknown>, 1)).toEqual([
      { value: 1 },
    ])
  })

  it('merges derived and explicit generators', function*({ expect }) {
    const merged = mergeEventGenerators(eventsFromSchemas(zodMachine), {
      INC: fc.constant({ value: 3 }),
    })

    yield* expect(sample(merged.INC as fc.Arbitrary<unknown>, 1)).toEqual([
      { value: 3 },
    ])
  })

  it('drives a property test from derived generators', function*({ expect }) {
    let numericInvariantChecks = 0
    const result = yield* Effect.promise(() =>
      propertyTest(zodMachine, {
        seed: 1,
        numRuns: 5,
        maxCommands: 3,
        events: mergeEventGenerators(
          eventsFromSchemas(zodMachine, { eventsWithoutSchema: 'skip' }),
          { INC: fc.record({ value: fc.integer({ min: 0, max: 2 }) }) },
        ),
        invariant: ({ snapshot }) => {
          if (typeof snapshot.context.count !== 'number') {
            throw new Error(
              `expected a numeric count, received ${typeof snapshot.context.count}`,
            )
          }
          numericInvariantChecks += 1
        },
      })
    )

    yield* expect({
      runs: result.coverage.runs,
      numericInvariantChecks: numericInvariantChecks > 0,
    }).toEqual({ runs: 5, numericInvariantChecks: true })
  })
})

describe('eventsFromSchemas with Effect Schema', () => {
  const effectEventSchema = Schema.Struct({ value: Schema.Int })
  const effectMachine = createMachine({
    schemas: {
      events: {
        INC: effectEventSchema as unknown as StandardSchemaV1,
      },
    },
    on: { INC: () => ({}) },
  })

  it('derives generators from the effect-schema entrypoint', function*({ expect }) {
    const events = eventsFromSchemasWithEffect(effectMachine) as Record<
      string,
      fc.Arbitrary<{ value: number }>
    >
    const incArbitrary = events['INC']
    if (incArbitrary === undefined) {
      throw new Error('expected an INC generator')
    }

    const values = sample(incArbitrary)

    yield* expect({
      count: values.length,
      allIntegers: values.every((value) => Number.isInteger(value.value)),
    }).toEqual({ count: 20, allIntegers: true })
  })

  it('points at the effect-schema entrypoint from the main entrypoint', function*({ expect }) {
    const message = thrownMessage(() => eventsFromSchemas(effectMachine))

    yield* expect(message).toEqual(
      "Error: [@xstate/test] Effect Schema found at 'INC'. Import `eventsFromSchemas` from '@xstate/test/effect-schema' to generate from Effect Schemas.",
    )
  })
})

describe.each([
  ['Zod v4', z],
  ['Zod v3', z3],
])('%s constraints', { timeout: 30_000 }, (_label, Z: any) => {
  const declaredOnlyByZodV3: Array<[string, () => unknown]> = Z === z3
    ? [['string min above max', () => Z.string().min(5).max(2)]]
    : []

  it.each<[string, () => SchemaLike]>([
    ['string min', () => Z.string().min(3)],
    ['string min/max', () => Z.string().min(2).max(6)],
    ['string length', () => Z.string().length(4)],
    ['string email', () => Z.string().email()],
    ['string uuid', () => Z.string().uuid()],
    ['string url', () => Z.string().url()],
    ['string regex', () => Z.string().regex(/^[a-f]{2,5}$/)],
    [
      'string startsWith/endsWith/includes',
      () => Z.string().startsWith('ab').endsWith('yz').includes('m'),
    ],
    ['string trim + min', () => Z.string().trim().min(1)],
    ['string toLowerCase', () => Z.string().toLowerCase()],
    ['number int range', () => Z.number().int().min(1).max(5)],
    ['number exclusive range', () => Z.number().gt(1).lt(5)],
    ['number multipleOf', () => Z.number().multipleOf(3).min(3).max(30)],
    ['number int multipleOf', () => Z.number().int().multipleOf(5)],
    ['number finite', () => Z.number().finite()],
    ['number nonnegative', () => Z.number().nonnegative()],
    ['array min/max', () => Z.array(Z.number()).min(2).max(4)],
    ['array length', () => Z.array(Z.string()).length(3)],
    ['set min/max', () => Z.set(Z.number().int()).min(1).max(3)],
    ['bigint min/max', () => Z.bigint().min(1n).max(5n)],
    ['date min/max', () => Z.date().min(epochDate(0)).max(epochDate(100000))],
    [
      'object of constrained fields',
      () =>
        Z.object({
          sku: Z.string().min(1),
          qty: Z.number().int().min(1).max(5),
        }),
    ],
    [
      'numeric enum',
      () => (Z === z ? z.enum(NumericEnum) : z3.nativeEnum(NumericEnum)),
    ],
    [
      'mixed enum',
      () => (Z === z ? z.enum(MixedEnum) : z3.nativeEnum(MixedEnum)),
    ],
    ['record with enum keys', () => Z.record(Z.enum(['a', 'b']), Z.number())],
    ['number gt(0).min(0)', () => Z.number().gt(0).min(0)],
    ['number min(0).gt(0)', () => Z.number().min(0).gt(0)],
    ['number lt(0).max(0)', () => Z.number().lt(0).max(0)],
    ['number negative', () => Z.number().negative()],
    ['number lt(0)', () => Z.number().lt(0)],
    ['number positive', () => Z.number().positive()],
    ['number nonpositive', () => Z.number().nonpositive()],
    ['number int multipleOf(0.5)', () => Z.number().int().multipleOf(0.5)],
    [
      'number multipleOf(2).multipleOf(3)',
      () => Z.number().multipleOf(2).multipleOf(3),
    ],
    [
      'number multipleOf(0.25).multipleOf(0.1)',
      () => Z.number().multipleOf(0.25).multipleOf(0.1),
    ],
    ['number multipleOf(0.1)', () => Z.number().multipleOf(0.1)],
    [
      'number multipleOf(0.1) range',
      () => Z.number().multipleOf(0.1).gt(0.3).lte(0.7),
    ],
    ['number multipleOf(0.01)', () => Z.number().multipleOf(0.01)],
    ['string email max', () => Z.string().email().max(10)],
    ['string email min', () => Z.string().email().min(24)],
    ['string uuid length', () => Z.string().uuid().length(36)],
    [
      'string regex max',
      () =>
        Z.string()
          .regex(/^[a-f]{2,8}$/)
          .max(4),
    ],
    ['string url max', () => Z.string().url().max(40)],
    ['set of enum at capacity', () => Z.set(Z.enum(['a', 'b'])).min(2)],
    ['lazy', () => Z.object({ name: Z.lazy(() => Z.string().min(1)) })],
  ])('generates values satisfying %s', function*([_name, build], { expect }) {
    yield* expect(parsesDrawnValues(build(), 20260923)).toEqual({ failed: false, runs: 200 })
  })

  it('generates only real numeric enum values', function*({ expect }) {
    const schema = Z === z ? z.enum(NumericEnum) : z3.nativeEnum(NumericEnum)
    const values = [
      ...new Set(sample(arbitraryFromSchema(schema) as fc.Arbitrary<number>, 100)),
    ].sort((left, right) => left - right)

    yield* expect(values).toEqual([NumericEnum.A, NumericEnum.B])
  })

  it('never generates -0 below an exclusive 0 bound', function*({ expect }) {
    const values = sample(arbitraryFromSchema(Z.number().negative()), 500)

    yield* expect({
      count: values.length,
      negativeZeros: values.filter((value) => Object.is(value, -0)),
    }).toEqual({ count: 500, negativeZeros: [] })
  })

  it.each<[string, () => unknown]>([
    ['email with startsWith', () => Z.string().email().startsWith('ab')],
    [
      'regex with endsWith',
      () =>
        Z.string()
          .regex(/^[a-z]+$/)
          .endsWith('z'),
    ],
    ['two formats', () => Z.string().email().uuid()],
  ])('rejects %s, naming the path', function*([_name, build], { expect }) {
    const message = thrownMessage(() => arbitraryFromSchema(build(), {}, 'evt.field'))

    yield* expect({ message }).toEqual({
      message: expect.stringMatching(
        /^Error: \[@xstate\/test\] Unsupported combination .+ at 'evt\.field'\. Pass an explicit generator for this payload\.$/,
      ),
    })
  })

  it.each<[string, () => unknown]>([
    ['email shorter than any address', () => Z.string().email().max(5)],
    ['uuid of the wrong length', () => Z.string().uuid().max(10)],
    ['set larger than its literal domain', () => Z.set(Z.literal('a')).min(2)],
    [
      'set larger than its union domain',
      () => Z.set(Z.union([Z.boolean(), Z.null()])).min(4),
    ],
    ...declaredOnlyByZodV3,
    ['array min above max', () => Z.array(Z.number()).min(5).max(2)],
    ['empty number range', () => Z.number().gt(1).lt(1)],
    ['empty bigint range', () => Z.bigint().min(5n).max(1n)],
    ['empty date range', () => Z.date().min(epochDate(10)).max(epochDate(0))],
    ['nonpositive and positive', () => Z.number().positive().max(0)],
  ])(
    'reports an unsatisfiable %s, naming the path',
    function*([_name, build], { expect }) {
      const message = thrownMessage(() => sample(arbitraryFromSchema(build(), {}, 'evt.field'), 5))

      yield* expect({ message }).toEqual({
        message: expect.stringMatching(
          /^Error: \[@xstate\/test\] Unsatisfiable Zod schema at 'evt\.field': .+\. Pass an explicit generator for this payload\.$/,
        ),
      })
    },
    5000,
  )

  it('bounds filters instead of hanging', function*({ expect }) {
    const message = thrownMessage(() =>
      sample(
        arbitraryFromSchema(Z.string().regex(/^a+$/).min(200), {}, 'evt.field'),
        5,
      )
    )

    yield* expect({ message }).toEqual({
      message:
        "Error: [@xstate/test] Could not generate a value satisfying the length bounds 200..Infinity at 'evt.field' after 1000 attempts. Pass an explicit generator for this payload.",
    })
  }, 5000)

  it('reports a recursive lazy schema, naming the path', function*({ expect }) {
    const node: z.ZodType = Z.object({
      name: Z.string(),
      children: Z.lazy(() => Z.array(node)),
    })

    const message = thrownMessage(() => arbitraryFromSchema(node, {}, 'evt'))

    yield* expect(message).toEqual(
      "Error: [@xstate/test] Recursive Zod schema at 'evt.children[]'. Recursive schemas cannot be derived; pass an explicit generator for this payload.",
    )
  })
})

describe('Zod v4-only schemas', () => {
  it.each<[string, () => SchemaLike]>([
    ['partialRecord', () => z.partialRecord(z.enum(['a', 'b']), z.number())],
    [
      'record with literal keys',
      () => z.record(z.literal(['x', 'y']), z.string()),
    ],
    ['exactOptional', () => z.object({ a: z.string().exactOptional() })],
    ['uuidv4', () => z.uuidv4()],
    ['uuidv6', () => z.uuidv6()],
    ['uuidv7', () => z.uuidv7()],
    ['guid', () => z.guid()],
    ['z.int().multipleOf(0.5)', () => z.int().multipleOf(0.5)],
    ['email().max(8)', () => z.email().max(8)],
  ])('generates values satisfying %s', function*([_name, build], { expect }) {
    yield* expect(parsesDrawnValues(build())).toEqual({ failed: false, runs: 200 })
  })

  it('generates every key of a record with enum keys', function*({ expect }) {
    const values = sample(
      pipe(z.record(z.enum(['a', 'b']), z.number()), arbitraryFromSchema) as fc.Arbitrary<
        Record<string, number>
      >,
    )

    yield* expect({
      count: values.length,
      keySets: [
        ...new Set(values.map((value) => Object.keys(value).sort().join(','))),
      ],
    }).toEqual({ count: 20, keySets: ['a,b'] })
  })

  it('keeps partialRecord keys optional', function*({ expect }) {
    const keyCounts = sample(
      arbitraryFromSchema(z.partialRecord(z.enum(['a', 'b']), z.number())),
      50,
    ).map((value) => Object.keys(value as object).length)

    yield* expect(keyCounts).toContain(0)
  })

  it('omits exactOptional keys instead of generating undefined', function*({ expect }) {
    const values = sample(
      arbitraryFromSchema(z.object({ a: z.string().exactOptional() })),
      100,
    ) as Record<string, unknown>[]

    yield* expect({
      count: values.length,
      someOmitTheKey: values.some((value) => !('a' in value)),
      presentKeysAreStrings: values
        .filter((value) => 'a' in value)
        .every((value) => typeof value['a'] === 'string'),
    }).toEqual({ count: 100, someOmitTheKey: true, presentKeysAreStrings: true })
  })

  it('reports a recursive getter-based object, naming the path', function*({ expect }) {
    const Node = z.object({
      name: z.string(),
      get children() {
        return z.array(Node)
      },
    })

    const message = thrownMessage(() => arbitraryFromSchema(Node, {}, 'evt'))

    yield* expect(message).toEqual(
      "Error: [@xstate/test] Recursive Zod schema at 'evt.children[]'. Recursive schemas cannot be derived; pass an explicit generator for this payload.",
    )
  })

  it('reports a recursive z.lazy schema, naming the path', function*({ expect }) {
    const tree: z.ZodType = z.lazy(() => z.object({ value: z.number(), next: tree.optional() }))

    const message = thrownMessage(() => arbitraryFromSchema(tree, {}, 'evt'))

    yield* expect(message).toEqual(
      "Error: [@xstate/test] Recursive Zod schema at 'evt.next'. Recursive schemas cannot be derived; pass an explicit generator for this payload.",
    )
  })
})

describe('eventsFromSchemas with wildcard schema keys', () => {
  const machine = createMachine({
    schemas: {
      events: {
        'user.*': z.object({ id: z.string().min(1) }),
        'user.special': z.object({ special: z.literal(true) }),
        '*': z.object({ any: z.boolean() }),
      },
    },
    on: {
      'user.login': () => ({}),
      'user.logout': () => ({}),
      'user.special': () => ({}),
      other: () => ({}),
    },
  })

  it.each(['empty', 'skip'] as const)(
    'derives matching event types from the wildcard schema (%s)',
    function*(eventsWithoutSchema, { expect }) {
      const events = eventsFromSchemas(machine, {
        eventsWithoutSchema,
      }) as Record<string, fc.Arbitrary<Record<string, unknown>>>

      const login = events['user.login']
      const special = events['user.special']
      const other = events['other']
      if (login === undefined || special === undefined || other === undefined) {
        throw new Error(
          'expected generators for user.login, user.special and other',
        )
      }

      const loginValues = sample(login)
      const specialValues = sample(special)
      const otherValues = sample(other)

      yield* expect({
        keys: Object.keys(events).sort(),
        valuesPerType: [
          loginValues.length,
          specialValues.length,
          otherValues.length,
        ],
        loginIdsAreStrings: loginValues.every(
          (value) => typeof value['id'] === 'string',
        ),
        loginIdsAreNonEmpty: loginValues.every(
          (value) => (value['id'] as string).length > 0,
        ),
        specialValues,
        otherAnyAreBooleans: otherValues.every(
          (value) => typeof value['any'] === 'boolean',
        ),
      }).toEqual({
        keys: ['other', 'user.login', 'user.logout', 'user.special'],
        valuesPerType: [20, 20, 20],
        loginIdsAreStrings: true,
        loginIdsAreNonEmpty: true,
        specialValues: specialValues.map(() => ({ special: true })),
        otherAnyAreBooleans: true,
      })
    },
  )

  it('generates events the machine accepts', function*({ expect }) {
    const events = eventsFromSchemas(machine) as Record<
      string,
      fc.Arbitrary<Record<string, unknown>>
    >
    const { validate } = machine.eventSchema['~standard']

    const sampled = Object.entries(events).flatMap(([type, arbitrary]) =>
      sample(arbitrary).map((payload) => ({ type, payload }))
    )

    const issues = yield* Effect.forEach(
      sampled,
      ({ type, payload }) =>
        Effect.promise(() =>
          Promise.resolve(validate({ type, ...payload })).then((result) =>
            'issues' in result ? result.issues : undefined
          )
        ),
    )

    yield* expect({
      checked: sampled.length,
      firstIssue: issues.find((value) => value !== undefined),
    }).toEqual({ checked: 80, firstIssue: undefined })
  })
})

describe('unsupported Zod checks', () => {
  it('reports the check kind instead of ignoring it', function*({ expect }) {
    const message = thrownMessage(() =>
      arbitraryFromSchema(
        z.number().refine((value) => value > 0),
        {},
        'evt.value',
      )
    )

    yield* expect(message).toEqual(
      "Error: [@xstate/test] Unsupported Zod check 'custom' on number at 'evt.value'. Pass an explicit generator for this payload.",
    )
  })
})
