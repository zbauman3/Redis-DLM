import LockManagerError from "../LockManagerError";

describe('Testing LockManagerError.ts', ()=>{

	test('The error class inits and sets the correct value', ()=>{

		const err = new LockManagerError('lockNotValid');

		expect(err instanceof LockManagerError).toBe(true);
		expect(typeof err.name).toBe('string');
		expect(typeof err.message).toBe('string');
		expect(err.messageName).toBe('lockNotValid');
		expect(err.name).toBe('LockManagerError');

	});

});