import { aquireLockLua, extendLockLua, removeLockLua } from "../luaStrings";

describe('Testing luaStrings.ts', ()=>{

	test('aquireLockLua, extendLockLua, removeLockLua exist and are valid strings.', ()=>{

		expect(typeof aquireLockLua.script).toBe('string');
		expect(typeof aquireLockLua.sha1).toBe('string');

		expect(typeof extendLockLua.script).toBe('string');
		expect(typeof extendLockLua.sha1).toBe('string');

		expect(typeof removeLockLua.script).toBe('string');
		expect(typeof removeLockLua.sha1).toBe('string');

	});

});