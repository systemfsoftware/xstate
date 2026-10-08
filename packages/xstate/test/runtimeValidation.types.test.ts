import { describe, it } from '@systemfsoftware/vitest'
import { z } from 'zod'
import { type AnySetupConfig, createCallbackLogic, createSystem, setup } from '../src/index.js'
import { standardSchemaValidator } from '../src/validation/index.js'

describe('runtime validation types', () => {
  it('rejects type-changing schemas only when validation is installed', function*({ expect }) {
    const transforming = z.string().transform((value) => value.length)

    const plain = setup({ schemas: { input: transforming } })

    if (false) {
      setup({
        validator: standardSchemaValidator(),
        // @ts-expect-error - runtime validation does not apply schema transforms
        schemas: { input: transforming },
      })
    }

    yield* expect(plain.schemas.input).toBe(transforming)
  })

  it('checks validated schema maps and nested state schemas', function*({ expect }) {
    const transforming = z.string().transform((value) => value.length)

    const s = setup({
      validator: standardSchemaValidator(),
      schemas: {
        actions: { track: { params: transforming } },
        guards: { allowed: { params: transforming } },
        meta: transforming,
      },
    })

    if (false) {
      setup({
        validator: standardSchemaValidator(),
        schemas: {
          events: {
            // @ts-expect-error - event schema changes its runtime type
            GO: transforming,
          },
        },
      })

      setup({
        validator: standardSchemaValidator(),
        states: {
          loading: {
            schemas: {
              // @ts-expect-error - state input schema changes its runtime type
              input: transforming,
            },
          },
        },
      })
    }

    yield* expect({
      metaIs: s.schemas.meta === transforming,
      paramsIs: s.schemas.actions.track.params === transforming,
      guardParamsIs: s.schemas.guards.allowed.params === transforming,
    }).toEqual({
      metaIs: true,
      paramsIs: true,
      guardParamsIs: true,
    })
  })

  it('allows same-type transforms as a documented generic limitation', function*({ expect }) {
    const sameType = z.string().transform((value) => value.trim())

    const s = setup({
      validator: standardSchemaValidator(),
      schemas: {
        input: sameType,
      },
    })

    yield* expect(s.schemas.input).toBe(sameType)
  })

  it('inherits validation across extend unless explicitly disabled', function*({ expect }) {
    const transforming = z.string().transform((value) => value.length)
    const validated = setup({ validator: standardSchemaValidator() })

    if (false) {
      validated.extend({
        schemas: {
          // @ts-expect-error - extended schemas inherit runtime validation
          input: transforming,
        },
      })

      validated.createMachine({
        schemas: {
          // @ts-expect-error - inline machine schemas use the setup validator
          input: transforming,
        },
      })

      validated.createMachine({
        states: {
          loading: {
            schemas: {
              // @ts-expect-error - inline state schemas use the setup validator
              input: transforming,
            },
          },
        },
      })
    }

    const unvalidated = validated.extend({
      validator: undefined,
      schemas: { input: transforming },
    })
    unvalidated.createMachine({
      schemas: { output: transforming },
    })

    yield* expect({
      inputIs: unvalidated.schemas.input === transforming,
    }).toEqual({
      inputIs: true,
    })
  })

  it('can install validation on a compatible derived setup', function*({ expect }) {
    const transforming = z.string().transform((value) => value.length)
    const inputSchema = z.string()
    setup().extend({ validator: standardSchemaValidator() })
    const validated = setup({ schemas: { input: inputSchema } }).extend({
      validator: standardSchemaValidator(),
    })

    if (false) {
      validated.createMachine({
        schemas: {
          // @ts-expect-error - derived validation applies to inline schemas
          output: transforming,
        },
      })
    }

    const incompatible = setup({ schemas: { input: transforming } })

    if (false) {
      // @ts-expect-error - inherited schema transforms cannot be validated
      incompatible.extend({
        validator: standardSchemaValidator(),
      })

      const incompatibleState = setup({
        states: {
          loading: { schemas: { input: transforming } },
        },
      })
      // @ts-expect-error - inherited state schema transforms cannot be validated
      incompatibleState.extend({ validator: standardSchemaValidator() })
    }

    yield* expect(validated.schemas.input).toBe(inputSchema)
  })

  it('preserves runtime validation types through createSystem().setup()', function*({ expect }) {
    const transforming = z.string().transform((value) => value.length)
    const receiver = createCallbackLogic<{ type: 'HELLO' }>(() => {})
    const system = createSystem({ registry: { receiver } })

    if (false) {
      system.setup({
        validator: standardSchemaValidator(),
        // @ts-expect-error - runtime validation does not apply schema transforms
        schemas: { input: transforming },
      })
    }

    const validated = system.setup({
      validator: standardSchemaValidator(),
    })

    if (false) {
      validated.extend({
        schemas: {
          // @ts-expect-error - extended schemas inherit runtime validation
          input: transforming,
        },
      })
    }

    validated.extend({ validator: standardSchemaValidator() })

    const setupFromConfig = <const TConfig extends AnySetupConfig>(
      config: TConfig,
    ) => system.setup(config)
    setupFromConfig({ validator: standardSchemaValidator() }).extend({
      validator: standardSchemaValidator(),
    })

    validated.createMachine({
      on: {
        TEST: ({ system }) => {
          system.get('receiver')?.send({ type: 'HELLO' })
          // @ts-expect-error - registry actor only accepts HELLO
          system.get('receiver')?.send({ type: 'OTHER' })
        },
      },
    })

    yield* expect(validated.schemas).toEqual({})
  })
})
