import RedLockError from "../RedLockError";

describe('Testing RedLockError.ts', ()=>{

	test('The error class inits and sets the correct value', ()=>{

		const err = new RedLockError('lockNotValid');

		expect(err instanceof RedLockError).toBe(true);
		expect(typeof err.name).toBe('string');
		expect(typeof err.message).toBe('string');
		expect(err.name).toBe('RedLockError');

	});

});