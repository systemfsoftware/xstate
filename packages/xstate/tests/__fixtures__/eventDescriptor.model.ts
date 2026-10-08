import { Match, Schema } from 'effect'

export const Event = Schema.Union([
  Schema.Struct({ type: Schema.Literals(['greet']), message: Schema.String }),
  Schema.Struct({
    type: Schema.Literals(['notify']),
    message: Schema.String,
    level: Schema.Literals(['info', 'error']),
  }),
  Schema.Struct({ type: Schema.Literals(['audit']), level: Schema.Literals(['info', 'error']) }),
  Schema.Struct({ type: Schema.Literals(['user']), name: Schema.String }),
  Schema.Struct({ type: Schema.Literals(['user.login']), name: Schema.String }),
  Schema.Struct({ type: Schema.Literals(['user.logout']) }),
  Schema.Struct({ type: Schema.Literals(['user.session.started']) }),
])
export type AssertionEvent = Schema.Schema.Type<typeof Event>

export const Descriptor = Schema.Literals([
  'greet',
  'notify',
  'audit',
  'user',
  'user.login',
  'user.logout',
  'user.session.started',
  '*',
  'user.*',
  'user.session.*',
])
export type Descriptor = Schema.Schema.Type<typeof Descriptor>

export const AssertionCommand = Schema.Union([
  Schema.TaggedStruct('Assert', { event: Event, descriptor: Descriptor }),
  Schema.TaggedStruct('AssertOneOf', { event: Event, descriptors: Schema.NonEmptyArray(Descriptor) }),
])
export type AssertionCommand = Schema.Schema.Type<typeof AssertionCommand>

export type AssertionResponse =
  | { readonly _tag: 'Accepted' }
  | { readonly _tag: 'Rejected'; readonly message: string }

export const accepted: AssertionResponse = { _tag: 'Accepted' }

const refused = (message: string): AssertionResponse => ({ _tag: 'Rejected', message })

const matchesDescriptor = (eventType: string, descriptor: string): boolean => {
  if (descriptor === '*') {
    return true
  }
  if (!descriptor.endsWith('.*')) {
    return descriptor === eventType
  }
  const head = descriptor.slice(0, -2).split('.')
  const segments = eventType.split('.')
  return head.every((segment, index) => segment === segments[index])
}

const refusalMessage = (event: AssertionEvent, types: readonly Descriptor[]): string => {
  const typesText = types.length === 1
    ? `type matching "${types[0]}"`
    : `one of types matching "${types.join('", "')}"`
  return `Expected event ${JSON.stringify(event)} to have ${typesText}`
}

export const descriptorsOf = (command: AssertionCommand): readonly Descriptor[] =>
  Match.value(command).pipe(
    Match.tag('Assert', (single) => [single.descriptor] as const),
    Match.tag('AssertOneOf', (many) => many.descriptors),
    Match.exhaustive,
  )

export const refusalOf = (command: AssertionCommand): AssertionResponse =>
  refused(refusalMessage(command.event, descriptorsOf(command)))

export const responseFor = (command: AssertionCommand): AssertionResponse => {
  const types = descriptorsOf(command)
  return types.some((descriptor) => matchesDescriptor(command.event.type, descriptor))
    ? accepted
    : refused(refusalMessage(command.event, types))
}

export const AssertionState = Schema.Struct({ accepted: Schema.Finite, rejected: Schema.Finite })
export type AssertionState = Schema.Schema.Type<typeof AssertionState>

export const initialAssertionState: AssertionState = { accepted: 0, rejected: 0 }

const counted = (state: AssertionState, response: AssertionResponse): AssertionState =>
  Match.value(response).pipe(
    Match.tag('Accepted', (): AssertionState => ({ accepted: state.accepted + 1, rejected: state.rejected })),
    Match.tag('Rejected', (): AssertionState => ({ accepted: state.accepted, rejected: state.rejected + 1 })),
    Match.exhaustive,
  )

const stepAssertion = (
  state: AssertionState,
  command: AssertionCommand,
): readonly [AssertionState, AssertionResponse] => {
  const response = responseFor(command)
  return [counted(state, response), response]
}

interface EventDescriptorModel {
  readonly state: Schema.Codec<AssertionState>
  readonly initial: AssertionState
  readonly precondition: (state: AssertionState, command: AssertionCommand) => boolean
  readonly step: (
    state: AssertionState,
    command: AssertionCommand,
  ) => readonly [AssertionState, AssertionResponse]
}

export const eventDescriptorModel: EventDescriptorModel = {
  state: AssertionState,
  initial: initialAssertionState,
  precondition: () => true,
  step: stepAssertion,
}
