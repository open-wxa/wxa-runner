/**
 * 保存的文件（wx.saveFile 等）：文件和临时文件一样存在开发服务器上，保存记录写在 Storage 里
 *
 * 保存记录和 Storage 一样按 appid 隔离、整页刷新后还在。开发服务器重启后文件就没了，对应的记录随之失效，
 * 相当于真机上缓存的文件被清理：Painter 等库查不到缓存时会重新下载。
 */

import { ApiHandler } from './registry';
import type { MiniProgramStorage } from './storage';
import { isTempFile, removeTempFile, saveTempFile, tempFileSize, tempFileType } from './tempFiles';

const NAMESPACE = 'savedFiles';

interface SavedFile {
  size: number;
  /** 秒 */
  createTime: number;
}

export function createSavedFileApis(storage: MiniProgramStorage): Record<string, ApiHandler> {
  const record = (filePath: string) => storage.get(NAMESPACE, filePath)?.data as SavedFile | undefined;

  /** 有保存记录、文件也还在时返回记录；文件已经没了就删掉记录 */
  const liveRecord = async (filePath: string) => {
    const saved = record(filePath);
    if (!saved) return undefined;
    if (await tempFileSize(filePath) !== null) return saved;
    storage.remove(NAMESPACE, filePath);
    return undefined;
  };

  return {
    // 和真机一样：存成新文件，原来的临时文件随之删除
    saveFile: async args => {
      // 指定保存路径的 FileSystemManager.saveFile 尚未实现，不能静默忽略。
      if (args.filePath) throw new Error('wxa-runner 暂不支持指定 filePath，不传时保存成功后返回 savedFilePath');
      const res = isTempFile(args.tempFilePath) ? await fetch(args.tempFilePath) : null;
      if (!res?.ok) throw new Error(`tempFilePath file not exist ${args.tempFilePath}`);
      const data = await res.blob();
      const savedFilePath = await saveTempFile(data, tempFileType(args.tempFilePath, data.type, 'tmp'));
      await removeTempFile(args.tempFilePath);
      storage.set(NAMESPACE, savedFilePath, { size: data.size, createTime: Math.floor(Date.now() / 1000) });
      return { savedFilePath };
    },
    getSavedFileList: async () => {
      const fileList = [];
      for (const filePath of storage.keys(NAMESPACE)) {
        const saved = await liveRecord(filePath);
        if (saved) fileList.push({ filePath, ...saved });
      }
      return { fileList };
    },
    getSavedFileInfo: async args => {
      const saved = await liveRecord(args.filePath);
      if (!saved) throw new Error(`file not exist ${args.filePath}`);
      return { ...saved };
    },
    removeSavedFile: async args => {
      if (!record(args.filePath)) throw new Error(`file not exist ${args.filePath}`);
      storage.remove(NAMESPACE, args.filePath);
      await removeTempFile(args.filePath);
    }
  };
}
