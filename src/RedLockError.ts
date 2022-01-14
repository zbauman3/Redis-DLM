
export const RedLockErrorMessages = {
	minClientCount: 'At least one client is required.',
	noConsensus: 'Failed to aquire a lock consensus.',
	tooLongToAquire: 'Took too long to aquire the lock.',
	lockNotValid: 'The lock is no longer valid.',
	excededMaxHold : 'The lock has exceded its maximum hold time.',
	wouldExcededMaxHold: "This extension would excede the lock's maximum hold time."
} as const;

export default class RedLockError extends Error {  
	
	public constructor(message: keyof typeof RedLockErrorMessages){
		
		super(message);

		this.name = 'RedLockError';
		this.message = RedLockErrorMessages[message];

		Error.captureStackTrace(this, this.constructor);

	}

};