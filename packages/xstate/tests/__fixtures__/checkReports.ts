import { Conformance } from '@systemfsoftware/conformance-spec'
import { Match, Schema } from 'effect'

export class CheckRejected extends Schema.TaggedError<CheckRejected>()('CheckRejected', {
  rendered: Schema.String,
}) {
  override get message(): string {
    return this.rendered
  }
}

const described = <C, R>(report: Conformance.Report<C, R>): string => {
  try {
    return Conformance.render(report)
  } catch {
    return JSON.stringify(report)
  }
}

export const passReportOf = <C, R>(report: Conformance.Report<C, R>): Conformance.Pass =>
  Match.value(report).pipe(
    Match.tag('Pass', (passed) => passed),
    Match.orElse((): never => {
      throw new CheckRejected({ rendered: described(report) })
    }),
  )

export const failReportOf = <C, R>(report: Conformance.Report<C, R>): Conformance.Fail<C, R> =>
  Match.value(report).pipe(
    Match.tag('Fail', (failed) => failed),
    Match.orElse((): never => {
      throw new CheckRejected({ rendered: described(report) })
    }),
  )
