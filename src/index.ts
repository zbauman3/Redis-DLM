import { randomBytes } from "crypto";
import { acquireLockLua, extendLockLua, removeLockLua } from "./luaStrings";
import type { Redis as IORedis, Cluster as IORedisCluster } from "ioredis";
import type { createClient as createRedisClient, createCluster as createRedisCluster } from "redis";
import LockManagerError from "./LockManagerError";

export type NodeRedisClient = ReturnType<typeof createRedisClient> | ReturnType<typeof createRedisCluster>;
export type IORedisClient = IORedis | IORedisCluster;
/** Clients/ClusterClients from either `ioredis` or `redis`. */
export type LockManagerClient = IORedisClient | NodeRedisClient;

/** The settings for a lock. */
export interface LockManagerSettings{
	/** The duration of the lock in milliseconds, before the time to acquire is subtracted. Default `10000`. */
	duration: number,
	/** The number of times to retry aquiring a lock. Default `0`. */
	retryCount: number,
	/** The max retry delay in milliseconds. A random time between this and zero will be selected. Default `500`. */
	retryDelay: number,
	/** The maximum time in milliseconds that a lock should be held across extensions. Default `60000`. */
	maxHoldTime: number,
	/** The percent of the duration that should be used as drift, combined with `driftConstant`. Between 0 and 1. Default `0.001`. */
	driftFactor: number,
	/** The fixed number of milliseconds to be used as drift, combined with `duration*driftFactor`. Default `5`. */
	driftConstant: number,
}

/** The default settings if not provided. */
export const defaultSettings: Readonly<LockManagerSettings> = Object.freeze({
	duration: 10000,
	retryCount: 0,
	retryDelay: 500,
	maxHoldTime: 60000,
	driftFactor: 0.001,
	driftConstant: 5,
});

/**
 * This represents a lock and its current state. This holds the information of
 * the lock and provides utility functions.
 * 
 * All times are in milliseconds.
 */
export class Lock{

	/** The time that the lock will expire at */
	protected expireTime = Date.now();
	/** Bound function from parent. */
	protected readonly _extend: LockManager['extend'];
	/** Bound function from parent. */
	protected readonly _release: LockManager['release'];

	/** The Redis key */
	public readonly key: string;
	/** The Redis key's unique value */
	public readonly uid: string;
	/** The initial duration. Used for extending. */
	public readonly duration: LockManagerSettings['duration'];
	/** The max time to hold the lock across extends */
	public readonly maxHoldTime: LockManagerSettings['maxHoldTime'];
	/** The time that this lock started at */
	public readonly startTime = Date.now();

	/** Get the remaining time on the lock */
	public get remainingTime(){

		const remaining = this.expireTime - Date.now();
		return (remaining < 0 ? 0 : remaining);

	}

	public constructor({
		key,
		uid,
		duration,
		remainingTime,
		maxHoldTime,
		extend,
		release,
	}:{
		key: string,
		uid: string,
		duration: LockManagerSettings['duration'],
		remainingTime: number,
		maxHoldTime: LockManagerSettings['maxHoldTime'],
		extend: LockManager['extend'],
		release: LockManager['release']
	}){

		this.key = key;
		this.uid = uid;
		this.duration = duration;
		this.expireTime = Date.now()+remainingTime;
		this.maxHoldTime = maxHoldTime;
		this._extend = extend;
		this._release = release;

	}

	/**
	 * Attempts to extend the lock. Resolves to the new `remainingTime`. \
	 * This does not attempt to remove the lock on failure.
	 */
	public async extend(settings: Partial<Pick<LockManagerSettings, 'duration' | 'driftFactor' | 'driftConstant'>> = {}){

		const remaining = await this._extend(this, settings);

		this.expireTime = Date.now()+remaining;

		return this.remainingTime;

	}

	/**
	 * Attempts to release the lock. Resolves to the number of 
	 * instances that confirmed the release.
	 */
	public async release(){

		const released = await this._release(this);

		this.expireTime = Date.now();

		return released;

	}

}

export default class LockManager{

	protected readonly clients: LockManagerClient[];
	/** The minimum number of clients who must confirm the lock */
	protected readonly clientConsensus: number;
	/** The default settings for this instance */
	protected readonly settings: Readonly<LockManagerSettings>;

	public constructor(clients: LockManagerClient[], settings: Partial<LockManagerSettings> = {}){

		if(clients.length === 0){
			throw new LockManagerError('minClientCount');
		}

		this.clients = [...clients];
		this.clientConsensus = Math.floor(this.clients.length/2)+1;

		this.settings = {
			duration: (typeof settings.duration === 'number' ? settings.duration : defaultSettings.duration),
			retryCount: (typeof settings.retryCount === 'number' ? settings.retryCount : defaultSettings.retryCount),
			retryDelay: (typeof settings.retryDelay === 'number' ? settings.retryDelay : defaultSettings.retryDelay),
			maxHoldTime: (typeof settings.maxHoldTime === 'number' ? settings.maxHoldTime : defaultSettings.maxHoldTime),
			driftFactor: (typeof settings.driftFactor === 'number' ? settings.driftFactor : defaultSettings.driftFactor),
			driftConstant: (typeof settings.driftConstant === 'number' ? settings.driftConstant : defaultSettings.driftConstant),
		};

		// bind so they can be passed to the Locks
		this.extend = this.extend.bind(this);
		this.release = this.release.bind(this);

	}

	/** Attempts to acquire the lock. Resolves to a new `Lock` class. */
	public async acquire(key: string, settings: Partial<LockManagerSettings> = {}){

		//step 1.
		const start = Date.now();
		//uid via https://redis.io/topics/distlock#correct-implementation-with-a-single-instance
		const uid = randomBytes(20).toString("hex");
		//settings for this specific lock
		const lockSettings: LockManagerSettings = {
			duration: (typeof settings.duration === 'number' ? settings.duration : this.settings.duration),
			retryCount: (typeof settings.retryCount === 'number' ? settings.retryCount : this.settings.retryCount),
			retryDelay: (typeof settings.retryDelay === 'number' ? settings.retryDelay : this.settings.retryDelay),
			maxHoldTime: (typeof settings.maxHoldTime === 'number' ? settings.maxHoldTime : this.settings.maxHoldTime),
			driftFactor: (typeof settings.driftFactor === 'number' ? settings.driftFactor : this.settings.driftFactor),
			driftConstant: (typeof settings.driftConstant === 'number' ? settings.driftConstant : this.settings.driftConstant),
		};

		//if a lock was acquired
		let success = false;

		//retryCount+1 to include the initial try
		for(let tries = lockSettings.retryCount+1; tries > 0; tries--){

			//step 2.
			const results = await Promise.allSettled(
				this.clients.map((client)=>this.runLua(client, acquireLockLua, [key], [uid, lockSettings.duration.toString()]))
			);

			let successCount = 0;
			for(let i = 0; i < results.length; i++){

				const result = results[i]!;//for TS
				if(result.status === 'fulfilled' && result.value === 'OK'){

					successCount++;

				}

			}

			//check if there was a consensus on the lock.
			if(successCount >= this.clientConsensus){

				success = true;
				break;

			}

			//don't do this on the last loop, no need
			if(tries > 1){

				//if there was not a consensus, try removing and wait to retry.
				await Promise.all([
					//step 5.
					this.noThrowQuickRelease({key, uid}),
					//to avoid split brain condition, via https://redis.io/topics/distlock#retry-on-failure
					new Promise((res)=>setTimeout(res, Math.floor(Math.random() * lockSettings.retryDelay)))
				]);

			}

		}

		if(!success){

			//was not successful
			//step 5.
			await this.noThrowQuickRelease({key, uid});

			throw new LockManagerError('noConsensus');

		}

		//steps 3 & 4.
		const remainingTime = this.calculateRemainingTime(start, lockSettings);

		if(remainingTime <= 0){

			//took too long
			//step 5.
			await this.noThrowQuickRelease({key, uid});

			throw new LockManagerError('tooLongToAcquire');

		}

		// create and return the lock
		return new Lock({
			key,
			uid,
			remainingTime,
			duration: lockSettings.duration,
			maxHoldTime: lockSettings.maxHoldTime,
			extend: this.extend,
			release: this.release,
		});

	}

	/** @deprecated Use `acquire`. This will be removed next major release. */
	public async aquire(...args: Parameters<InstanceType<typeof LockManager>['acquire']>){
		return this.acquire(...args);
	} 

	/**
	 * Attempts to extend the lock. Resolves to the new `remainingTime`. \
	 * This does not attempt to remove the lock on failure. \
	 * 
	 * This is meant to be bound and passed to the Locks, then called from
	 * there. The lock can then update its `expireTime`.
	 */
	protected async extend(lock: Lock, settings: Partial<Pick<LockManagerSettings, 'duration' | 'driftFactor' | 'driftConstant'>> = {}){

		//get the start time to track the time to extend
		const start = Date.now();

		if(lock.remainingTime === 0){
			throw new LockManagerError('lockNotValid');
		}

		//how long the lock has already been held
		const currentHoldTime = (Date.now() - lock.startTime);

		//held for too long
		if(currentHoldTime >= lock.maxHoldTime){
			throw new LockManagerError('excededMaxHold');
		}

		//settings for this extend
		const lockSettings: Pick<LockManagerSettings, 'duration' | 'driftFactor' | 'driftConstant'> = {
			duration: (typeof settings.duration === 'number' ? settings.duration : lock.duration),
			driftFactor: (typeof settings.driftFactor === 'number' ? settings.driftFactor : this.settings.driftFactor),
			driftConstant: (typeof settings.driftConstant === 'number' ? settings.driftConstant : this.settings.driftConstant),
		};

		//if extending would put it past the max hold time
		if(currentHoldTime+lockSettings.duration > lock.maxHoldTime){
			throw new LockManagerError('wouldExcededMaxHold');
		}

		const results = await Promise.allSettled(
			this.clients.map((client)=>this.runLua(client, extendLockLua, [lock.key], [lock.uid, lockSettings.duration.toString()]))
		);

		let successCount = 0;

		for(let i = 0; i < results.length; i++){

			const result = results[i]!;//for TS
			if(result.status === 'fulfilled' && result.value === 1){

				successCount++;

			}

		}

		//check if there was a consensus on the lock.
		if(successCount < this.clientConsensus){
			
			throw new LockManagerError('noConsensus');

		}

		const remainingTime = this.calculateRemainingTime(start, lockSettings);

		//took too long to acquire the lock
		if(remainingTime <= 0){

			throw new LockManagerError('tooLongToAcquire');

		}

		return remainingTime;

	}

	/**
	 * Attempts to release the provided lock. Resolves to the number of 
	 * instances that confirmed the release.
	 */
	protected async release(lock: Lock){

		const results = await Promise.allSettled(
			this.clients.map((client)=>this.runLua(client, removeLockLua, [lock.key], [lock.uid]))
		);

		let numReleased = 0;

		for(let i = 0; i < results.length; i++){

			const result = results[i]!;//for TS
			if(result.status === 'fulfilled' && result.value === 'Deleted'){

				numReleased++;

			}

		}

		if(numReleased < this.clientConsensus){
			throw new LockManagerError('releaseFailure');
		}

		return numReleased;

	}

	/** Executes the given Lua & arguments on the provided client */
	protected async runLua(
		client: LockManagerClient,
		lua: typeof acquireLockLua | typeof extendLockLua | typeof removeLockLua,
		keys: string[],
		argv: string[]
	){

		try{

			// First try to send view SHA1
			const res = await (this.isIORedisClient(client)
				? client.evalsha(lua.sha1, keys.length, ...keys, ...argv)
				: client.evalSha(lua.sha1, {keys: keys, arguments: argv})
			);
			return res;

		}catch(e){

			// If this is not a `NOSCRIPT` error, throw it
			if(!this.isNoScriptError(e)){
				throw e;
			}

		}

		//if there was an error, and it was `NOSCRIPT`, try sending the scripts directly.
		return (this.isIORedisClient(client)
			? client.eval(lua.script, keys.length, ...keys, ...argv)
			: client.eval(lua.script, {keys: keys, arguments: argv})
		);

	}

	/** Calculates the remaining time of a lock, including drift. */
	protected calculateRemainingTime(start: number, settings: Pick<LockManagerSettings, 'duration' | 'driftFactor' | 'driftConstant'>){

		//duration - execution time - drift;
		return Math.floor(settings.duration - (Date.now() - start) - (settings.driftFactor * settings.duration) - settings.driftConstant);

	}

	/** Checks if a given value is an Error and is a `NOSCRIPT` error. */
	protected isNoScriptError(e: any){

		return (
			(e instanceof Error) &&
			/NOSCRIPT/i.test(e.message)
		);

	}

	/** A typeguard for determining which client this is */
	protected isIORedisClient(client: LockManagerClient):client is IORedisClient{

		return (
			('eval' in client) &&
			('evalsha' in client) && 
			('defineCommand' in client) && 
			('createBuiltinCommand' in client)
		);

	}

	/** A helper function to release without an existing `Lock` */
	protected async noThrowQuickRelease({key, uid}:{key: string, uid: string}){

		try{

			await this.release(new Lock({
				key,
				uid,
				duration: 0,
				remainingTime: 0,
				maxHoldTime: 0,
				extend: this.extend,
				release: this.release,
			}));

		}catch(_){ /** noop */ }

	}

}