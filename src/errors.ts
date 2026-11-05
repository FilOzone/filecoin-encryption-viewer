export class NotAvailableError extends Error {
  override name = 'NotAvailableError'
}
export class TooLargeError extends Error {
  override name = 'TooLargeError'
}
/** A real share with more entries, or deeper paths, than the Viewer will list. */
export class TooManyEntriesError extends Error {
  override name = 'TooManyEntriesError'
}
/** The Access key doesn't open the link's payload: not the key it was wrapped to, or not a valid key at all. */
export class WrongAccessKeyError extends Error {
  override name = 'WrongAccessKeyError'
}
/** The payload opened, but it's for another upload than the envelope at this CID. */
export class OtherUploadError extends Error {
  override name = 'OtherUploadError'
}
/** The Delivery's claim chain has expired. */
export class ShareExpiredError extends Error {
  override name = 'ShareExpiredError'
}
/** The link's payload isn't a valid grant or Delivery, or its signatures don't check out. */
export class DamagedLinkError extends Error {
  override name = 'DamagedLinkError'
}
/** FEE refused a chunk: the ciphertext (or its authenticated labels) was modified. */
export class ShareModifiedError extends Error {
  override name = 'ShareModifiedError'
}
export class NotAShareError extends Error {
  override name = 'NotAShareError'
  constructor(options?: ErrorOptions) {
    super("This link doesn't point to a filecoin-pin encrypted share", options)
  }
}

/** No service worker controls this tab, so the request reached inbrowser.link's server, which answers with its installer page. */
export class GatewayInactiveError extends Error {
  override name = 'GatewayInactiveError'
}
/** A web page came back instead of the share, with the gateway's service worker in control: a captive portal, a proxy. */
export class UnexpectedPageError extends Error {
  override name = 'UnexpectedPageError'
}

/** The server answered a Range request with a 200. `response` is unread, so its body can still be saved. */
export class RangeUnsupportedError extends Error {
  override name = 'RangeUnsupportedError'
  response: Response
  constructor(response: Response) {
    super('The server ignored the Range request')
    this.response = response
  }
}
