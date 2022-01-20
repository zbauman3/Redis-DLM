import { acquireLockLua, extendLockLua, removeLockLua } from "../luaStrings";

describe('Testing luaStrings.ts', ()=>{

	test('acquireLockLua, extendLockLua, removeLockLua exist and are valid strings.', ()=>{

		expect(typeof acquireLockLua.script).toBe('string');
		expect(typeof acquireLockLua.sha1).toBe('string');

		expect(typeof extendLockLua.script).toBe('string');
		expect(typeof extendLockLua.sha1).toBe('string');

		expect(typeof removeLockLua.script).toBe('string');
		expect(typeof removeLockLua.sha1).toBe('string');

	});

});