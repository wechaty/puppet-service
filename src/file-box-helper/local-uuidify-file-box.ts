import {
  FileBox,
}                         from 'file-box'
import type {
  puppet as pbPuppet,
}                         from 'wechaty-grpc'
import {
  cloneClass,
  Constructor,
}                         from 'clone-class'

import {
  uuidLoaderLocal,
  uuidSaverLocal,
}                   from './local-uuid-helper.js'
import type { UuidFileManager } from './uuid-file-manager.js'

type UuidifyFileBoxLocalFactory = (uuidFileManager: UuidFileManager) => typeof FileBox

const uuidifyFileBoxLocal: UuidifyFileBoxLocalFactory = (
  uuidFileManager,
) => {
  /**
   * `as any`:
   *
   * Huan(202110): TypeError: Cannot read property 'valueDeclaration' of undefined #58
   *  https://github.com/huan/clone-class/issues/58
   */
  const FileBoxUuid: typeof FileBox = cloneClass(FileBox as any as Constructor<FileBox>) as any

  FileBoxUuid.setUuidLoader(uuidLoaderLocal(uuidFileManager))
  FileBoxUuid.setUuidSaver(uuidSaverLocal(uuidFileManager))

  return FileBoxUuid
}

export {
  uuidifyFileBoxLocal,
}
