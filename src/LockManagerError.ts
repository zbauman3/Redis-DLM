
export const LockManagerErrorMessages = {
	minClientCount: 'At least one client is required.',
	noConsensus: 'Failed to acquire a lock consensus.',
	tooLongToAcquire: 'Took too long to acquire the lock.',
	lockNotValid: 'The lock is no longer valid.',
	excededMaxHold: 'The lock has exceded its maximum hold time.',
	wouldExcededMaxHold: "This extension would excede the lock's maximum hold time.",
	releaseFailure: 'Failed to release a majority of locks.',
} as const;

export default class LockManagerError extends Error {

	public messageName: string;
	
	public constructor(message: keyof typeof LockManagerErrorMessages){
		
		super(message);

		this.name = 'LockManagerError';
		this.message = LockManagerErrorMessages[message];
		this.messageName = message;

		Error.captureStackTrace(this, this.constructor);

	}

};