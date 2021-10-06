import type {
  UuidLoader,
  UuidSaver,
}                       from 'file-box'

import type { UuidFileManager } from './uuid-file-manager.js'

const uuidLoaderLocal: (uuidFileManager: UuidFileManager) => UuidLoader = (
  uuidFileManager,
) => uuid => uuidFileManager.load(uuid)

const uuidSaverLocal: (uuidFileManager: UuidFileManager) => UuidSaver = (
  uuidFileManager,
) => stream => uuidFileManager.save(stream)

export {
  uuidLoaderLocal,
  uuidSaverLocal,
}
