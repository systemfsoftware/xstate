import { describe, it } from '@systemfsoftware/vitest'
import * as Schema from 'effect/Schema'
import * as fc from 'fast-check'
import { fromEffectSchema, fromEffectSchemas } from '../src/effect-schema.js'

describe('Effect Schema adapter', () => {
  it('returns native FastCheck arbitraries that honor refinements', function*({
    expect,
  }) {
    const positive = Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))
    const derived = fromEffectSchema(positive)

    const sample = fc.sample(derived, { seed: 1, numRuns: 20 })
    yield* expect({
      sample,
      rejected: sample.filter(
        (value) => !(Number.isInteger(value) && value > 0),
      ),
    }).toEqual({
      sample: expect.arrayContaining([expect.any(Number)]),
      rejected: [],
    })
  })

  it('converts keyed payload schemas', function*({ expect }) {
    const events = fromEffectSchemas({
      INC: Schema.Struct({ value: Schema.Int }),
      RESET: Schema.Struct({}),
    })

    yield* expect({
      inc: fc.sample(events.INC, 1)[0],
      reset: fc.sample(events.RESET, 1)[0],
    }).toEqual({ inc: { value: expect.any(Number) }, reset: {} })
  })
})
