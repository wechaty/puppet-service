import {
  FileBoxChunk,
}                 from '@chatie/grpc'

import {
  Readable,
  TypedTransform,
}                   from './typed-stream'

const encoder = <T extends { setFileBoxChunk: (chunk: FileBoxChunk) => void }>(
  message: T,
) => new TypedTransform<FileBoxChunk, T>({
  objectMode: true,
  transform: (chunk: FileBoxChunk, _: any, callback: (error: Error | null, data: T) => void) => {
    message.setFileBoxChunk(chunk)
    callback(null, message)
  },
})

function packFileBoxChunk<T extends { setFileBoxChunk: (chunk: FileBoxChunk) => void }> (
  stream: Readable<FileBoxChunk>,
  predefinedMessage: T,
): Readable<T> {
  const outStream = stream.pipe(encoder(predefinedMessage))
  return outStream
}

function unpackFileBoxChunk<T extends { getFileBoxChunk: () => FileBoxChunk}> (
  stream: Readable<T>,
): Readable<FileBoxChunk> {
  return stream.pipe(decoder())
}

const decoder = <T extends { getFileBoxChunk: () => FileBoxChunk }>() => new TypedTransform<T, FileBoxChunk>({
  objectMode: true,
  transform: (chunk: T, _: any, callback: (error: Error | null, data: FileBoxChunk) => void) => {
    callback(null, chunk.getFileBoxChunk())
  },
})

export {
  packFileBoxChunk,
  unpackFileBoxChunk,
}
