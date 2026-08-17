import { Readable } from "node:stream"

export const readableToWebBytes = (
  stream: Readable,
): ReadableStream<Uint8Array> =>
  Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>
