import { describe, expect, it } from 'vitest'
import {
  DamagedLinkError,
  GatewayInactiveError,
  NotAShareError,
  NotAvailableError,
  OtherUploadError,
  ShareExpiredError,
  ShareModifiedError,
  TooLargeError,
  TooManyEntriesError,
  UnexpectedPageError,
  WrongAccessKeyError,
} from '../src/errors.js'
import { unlockErrorMessage } from '../src/ui.js'

describe('unlockErrorMessage', () => {
  it.each([
    [new WrongAccessKeyError('x'), "That Access key doesn't open this share. Check it and try again."],
    [new OtherUploadError('x'), 'This link is for another upload. Ask the sender for the right link.'],
    [new ShareExpiredError('x'), 'This share has expired. Ask the sender for a new link.'],
    [new DamagedLinkError('x'), 'This link is damaged. Copy it again, or ask the sender for a new one.'],
    [new ShareModifiedError('x'), 'This share is damaged or was modified, so it was not opened.'],
    [
      new GatewayInactiveError('x'),
      "This page isn't connected to the Filecoin gateway yet. Open the link again, or reload the page.",
    ],
    [
      new UnexpectedPageError('x'),
      'A web page came back instead of this share. Try again later, or open the link on another network.',
    ],
  ])('maps %s', (error, message) => {
    expect(unlockErrorMessage(error)).toBe(message)
  })

  it('maps NotAvailableError', () => {
    expect(unlockErrorMessage(new NotAvailableError('x'))).toBe(
      "This share isn't available yet, or the download was interrupted. Try again in a few minutes."
    )
  })

  it('maps TooLargeError', () => {
    expect(unlockErrorMessage(new TooLargeError('x'))).toBe(
      'This file is too large to save in this browser. Use `filecoin-pin decrypt` instead.'
    )
  })

  it('maps TooManyEntriesError, pointing to the CLI and not to saving', () => {
    expect(unlockErrorMessage(new TooManyEntriesError('x'))).toBe(
      'This share has too many files, or folders nested too deeply, to open in the browser. Use `filecoin-pin decrypt`.'
    )
  })

  it('maps NotAShareError', () => {
    expect(unlockErrorMessage(new NotAShareError())).toBe("This link doesn't point to a filecoin-pin encrypted share.")
  })

  it('maps anything else to the generic message', () => {
    expect(unlockErrorMessage(new Error('boom'))).toBe('Something went wrong opening this share. Try again.')
    expect(unlockErrorMessage('nope')).toBe('Something went wrong opening this share. Try again.')
  })
})
