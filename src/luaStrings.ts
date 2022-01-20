import { resolve as resolvePath } from "path";
import { readFileSync } from 'fs';
import { createHash } from "crypto";

const acquireLockLuaScript = readFileSync(resolvePath(__dirname, '../lua/acquireLock.lua'), {encoding: 'utf8'}).trim();
export const acquireLockLua = {
	script: acquireLockLuaScript,
	sha1: createHash("sha1").update(acquireLockLuaScript).digest("hex"),
} as const;

const extendLockLuaScript = readFileSync(resolvePath(__dirname, '../lua/extendLock.lua'), {encoding: 'utf8'}).trim();
export const extendLockLua = {
	script: extendLockLuaScript,
	sha1: createHash("sha1").update(extendLockLuaScript).digest("hex"),
} as const;

const removeLockLuaScript = readFileSync(resolvePath(__dirname, '../lua/removeLock.lua'), {encoding: 'utf8'}).trim();
export const removeLockLua = {
	script: removeLockLuaScript,
	sha1: createHash("sha1").update(removeLockLuaScript).digest("hex"),
} as const;
