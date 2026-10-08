import { Conformance } from '@systemfsoftware/conformance-spec'
import { assertEvent, type ExtractEvent } from '@systemfsoftware/xstate'
import { Context, Effect, Layer, Match, Schema } from 'effect'
import {
  accepted,
  type AssertionCommand,
  type AssertionEvent,
  type AssertionResponse,
  descriptorsOf,
  refusalOf,
} from './eventDescriptor.model.js'

export type AppEvent =
  | { readonly type: 'greet'; readonly message: string }
  | { readonly type: 'notify'; readonly message: string; readonly level: 'info' | 'error' }
  | { readonly type: 'audit'; readonly level: 'info' | 'error' }
  | { readonly type: 'user'; readonly name: string }
  | { readonly type: 'user.login'; readonly name: string }
  | { readonly type: 'user.logout' }
  | { readonly type: 'user.session.started' }

export const greetMessageOf = (event: AppEvent): string => {
  assertEvent(event, 'greet')
  return event.message
}

export const greetOrNotifyMessageOf = (event: AppEvent): string => {
  assertEvent(event, ['greet', 'notify'])
  return event.message
}

export const userWildcardTypeOf = (event: AppEvent): ExtractEvent<AppEvent, 'user.*'>['type'] => {
  assertEvent(event, 'user.*')
  return event.type
}

const assertGreet: (event: AppEvent) => asserts event is ExtractEvent<AppEvent, 'greet'> = assertEvent('greet')

export const boundGreetMessageOf = (event: AppEvent): string => {
  assertGreet(event)
  return event.message
}

export interface AssertionLedger {
  exactAccepted: number
  exactRefused: number
  unionAccepted: number
  unionRefused: number
  listRefused: number
}

export interface AssertionHandle {
  readonly assert: (command: AssertionCommand) => AssertionResponse
  readonly observed: AssertionLedger
}

export interface AssertionSubject {
  readonly layer: Layer.Layer<EventAssertion>
  readonly observed: AssertionLedger
}

export class EventAssertion extends Context.Service<EventAssertion, AssertionHandle>()(
  '@systemfsoftware/xstate/tests/event-assertions/EventAssertion',
) {}

export class CheckRejected extends Schema.TaggedError<CheckRejected>()('CheckRejected', {
  rendered: Schema.String,
}) {
  override get message(): string {
    return this.rendered
  }
}

type Assertion = (command: AssertionCommand) => AssertionResponse

const responseOf = (assert: () => void): AssertionResponse => {
  try {
    assert()
    return accepted
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error
    }
    return { _tag: 'Rejected', message: error.message }
  }
}

const publishedAssertion: Assertion = (command) =>
  responseOf(() =>
    Match.value(command).pipe(
      Match.tag('Assert', (single) => {
        assertEvent(single.event, single.descriptor)
      }),
      Match.tag('AssertOneOf', (many) => {
        assertEvent(many.event, many.descriptors)
      }),
      Match.exhaustive,
    )
  )

type BoundAssertion = (event: AssertionEvent) => asserts event is AssertionEvent

const boundAssertion: Assertion = (command) =>
  responseOf(() =>
    Match.value(command).pipe(
      Match.tag('Assert', (single) => {
        const check: BoundAssertion = assertEvent(single.descriptor)
        check(single.event)
      }),
      Match.tag('AssertOneOf', (many) => {
        const check: BoundAssertion = assertEvent(many.descriptors)
        check(many.event)
      }),
      Match.exhaustive,
    )
  )

const wildcardBlindAssertion: Assertion = (command) => {
  const matched = descriptorsOf(command).some((descriptor) => descriptor === command.event.type)
  return matched ? accepted : refusalOf(command)
}

const tally =
  (observed: AssertionLedger) => (command: AssertionCommand, response: AssertionResponse): AssertionResponse => {
    const isAccepted = Match.value(response).pipe(
      Match.tag('Accepted', () => true),
      Match.tag('Rejected', () => false),
      Match.exhaustive,
    )
    Match.value(command).pipe(
      Match.tag('Assert', () => {
        if (isAccepted) {
          observed.exactAccepted += 1
        } else {
          observed.exactRefused += 1
        }
      }),
      Match.tag('AssertOneOf', (many) => {
        if (isAccepted) {
          observed.unionAccepted += 1
        } else {
          observed.unionRefused += 1
          if (many.descriptors.length > 1) {
            observed.listRefused += 1
          }
        }
      }),
      Match.exhaustive,
    )
    return response
  }

const subjectOf = (assertion: Assertion): AssertionSubject => {
  const observed: AssertionLedger = {
    exactAccepted: 0,
    exactRefused: 0,
    unionAccepted: 0,
    unionRefused: 0,
    listRefused: 0,
  }
  const record = tally(observed)
  return {
    observed,
    layer: Layer.succeed(EventAssertion, {
      observed,
      assert: (command) => record(command, assertion(command)),
    }),
  }
}

export const makeEventAssertionSubject = (): AssertionSubject => subjectOf(publishedAssertion)

export const makeBoundAssertionSubject = (): AssertionSubject => subjectOf(boundAssertion)

export const makeWildcardBlindSubject = (): AssertionSubject => subjectOf(wildcardBlindAssertion)

export const runAssertionCommand = (
  command: AssertionCommand,
): Effect.Effect<AssertionResponse, never, EventAssertion> =>
  Effect.gen(function*() {
    const subject = yield* EventAssertion
    return subject.assert(command)
  })

export const passReportOf = (
  report: Conformance.Report<AssertionCommand, AssertionResponse>,
): Conformance.Pass =>
  Match.value(report).pipe(
    Match.tag('Pass', (passed) => passed),
    Match.orElse((): never => {
      throw new CheckRejected({ rendered: Conformance.render(report) })
    }),
  )

export const failReportOf = (
  report: Conformance.Report<AssertionCommand, AssertionResponse>,
): Conformance.Fail<AssertionCommand, AssertionResponse> =>
  Match.value(report).pipe(
    Match.tag('Fail', (failed) => failed),
    Match.orElse((): never => {
      throw new CheckRejected({ rendered: Conformance.render(report) })
    }),
  )
