import { resolve as resolvePath } from "path";
import { readFileSync } from 'fs';

export const aquireLockLua = readFileSync(resolvePath(__dirname, '../lua/aquireLock.lua'), {encoding: 'utf8'});
export const extendLockLua = readFileSync(resolvePath(__dirname, '../lua/extendLock.lua'), {encoding: 'utf8'});
export const removeLockLua = readFileSync(resolvePath(__dirname, '../lua/removeLock.lua'), {encoding: 'utf8'});