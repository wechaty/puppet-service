import {
  FileBoxChunk,
}                 from '@chatie/grpc'

import {
  Readable,
  Transform,
}                   from 'stronger-typed-streams'

/**
 * Any Protocol Buffer message that include a FileBoxChunk
 */
type PbFileBoxChunk = {
  getFileBoxChunk: () => FileBoxChunk | undefined
  setFileBoxChunk: (chunk: FileBoxChunk) => void
}

/**
 * Wrap FileBoxChunk
 */
const encoder = <T extends PbFileBoxChunk>(
  PbMessage: { new(): T },
) => new Transform<FileBoxChunk, T>({
  objectMode: true,
  transform: (chunk: FileBoxChunk, _: any, callback: (error: Error | null, data: T) => void) => {
    const message = new PbMessage()
    message.setFileBoxChunk(chunk)
    callback(null, message)
  },
})

const packFileBoxChunk = <T extends PbFileBoxChunk> (
  DataConstructor: { new(): T },
) => (stream: Readable<FileBoxChunk>): Readable<T> => stream.pipe(encoder(DataConstructor))

/**
 * Unwrap FileBoxChunk
 */
const decoder = <T extends PbFileBoxChunk>() => new Transform<T, FileBoxChunk>({
  objectMode: true,
  transform: (chunk: T, _: any, callback: (error: Error | null, data?: FileBoxChunk) => void) => {
    const fileBoxChunk = chunk.getFileBoxChunk()
    if (!fileBoxChunk) {
      callback(new Error('No FileBoxChunk'))
    } else {
      callback(null, fileBoxChunk)
    }
  },
})

function unpackFileBoxChunk<T extends PbFileBoxChunk> (
  stream: Readable<T>,
): Readable<FileBoxChunk> {
  return stream.pipe(decoder())
}

export {
  packFileBoxChunk,
  unpackFileBoxChunk,
}
