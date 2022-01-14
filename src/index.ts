import { randomBytes } from "crypto";
import { aquireLockLua, extendLockLua, removeLockLua } from "./luaStrings";
import type { Redis as IORedis, Cluster as IORedisCluster } from "ioredis";
import type { createClient as createRedisClient, createCluster as createRedisCluster } from "redis";

/**
 * @see https://redis.io/topics/distlock
 * 
 * N = 5 (Redis instances)
 * 
 * 1. It gets the current time in milliseconds.
 * 2. It tries to acquire the lock in all the N instances sequentially, using
 *    the same key name and random value in all the instances. During step 2,
 *    when setting the lock in each instance, the client uses a timeout which
 *    is small compared to the total lock auto-release time in order to acquire
 *    it. For example if the auto-release time is 10 seconds, the timeout could
 *    be in the ~ 5-50 milliseconds range. This prevents the client from 
 *    remaining blocked for a long time trying to talk with a Redis node which
 *    is down: if an instance is not available, we should try to talk with the
 *    next instance ASAP.
 * 3. The client computes how much time elapsed in order to acquire the lock,
 *    by subtracting from the current time the timestamp obtained in step 1. If
 *    and only if the client was able to acquire the lock in the majority of
 *    the instances (at least 3), and the total time elapsed to acquire the
 *    lock is less than lock validity time, the lock is considered acquired.
 * 4. If the lock was acquired, its validity time is considered to be the
 *    initial validity time minus the time elapsed, as computed in step 3.
 * 5. If the client failed to acquire the lock for some reason (either it was
 *    not able to lock N/2+1 instances or the validity time is negative), it
 *    will try to unlock all the instances (even the instances it believed it
 *    was not able to lock).
 */






/**
 * @todo
 * 
 * - [ ] Tests
 * - [ ] Custom Errors
 * - [ ] Finish extend
 * 
 */







/** Clients or ClusterClients from either ioredis or redis. */
export type NodeRedisClient = ReturnType<typeof createRedisClient> | ReturnType<typeof createRedisCluster>;
export type IORedisClient = IORedis | IORedisCluster;
export type RedLockClient = IORedisClient | NodeRedisClient;

/** The settings for a lock. */
export interface RedLockSettings{
	/** The duration of the lock in milliseconds, before the time to aquire is subtracted. Default `30000`. */
	duration: number,
	/** The number of times to retry aquiring a lock. Default `0`. */
	retryCount: number,
	/** The max retry delay in milliseconds. A random time between this and zero will be selected. Default `500`. */
	retryDelay: number,
	/** The maximum time in milliseconds that a lock should be held across extensions. Default `300000`. */
	maxHoldTime: number,
	/** The percent of the duration that should be used in drift. Between 0 and 1. Default `0.01`. */
	driftFactor: number,
	/** The number of milliseconds added to the drift. Default `2`. */
	driftConstant: number,
}

const defaultSettings: Readonly<RedLockSettings> = Object.freeze({
	duration: 30*1000,
	retryCount: 0,
	retryDelay: 500,
	maxHoldTime: 60*5*1000,
	driftFactor: 0.01,
	driftConstant: 2,
});

/**
 * This represents a lock and its current state. This essentially just holds
 * the information of the lock and provides utility functions.
 * 
 * All times are in milliseconds.
 */
export class Lock{

	/** The time that the lock will expire at */
	private expireTime = Date.now();
	/** Bound function from parent. */
	private readonly _extend: RedLock['extend'];
	/** Bound function from parent. */
	private readonly _release: RedLock['release'];

	/** The Redis key */
	public readonly key: string;
	/** The Redis key's unique value */
	public readonly uid: string;
	/** The initial duration, used for extend */
	public readonly duration: RedLockSettings['duration'];
	/** Max time to hold the lock across extends. */
	public readonly maxHoldTime: RedLockSettings['maxHoldTime'];
	/** The time that this lock started at */
	public readonly startTime = Date.now();

	/** Set the remaining time (calculates `expireTime`) */
	private set remainingTime(duration: number){

		this.expireTime = Date.now()+duration;

	}
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
		duration: RedLockSettings['duration'],
		remainingTime: number,
		maxHoldTime: RedLockSettings['maxHoldTime'],
		extend: RedLock['extend'],
		release: RedLock['release']
	}){

		this.key = key;
		this.uid = uid;
		this.duration = duration;
		this.remainingTime = remainingTime;
		this.maxHoldTime = maxHoldTime;
		this._extend = extend;
		this._release = release;

	};

	/** Attempts to extend the lock by `duration` again. Resolves to the new `remainingTime`. */
	public async extend(){

		this.remainingTime = await this._extend(this);
		return this.remainingTime;

	};

	/** Attempts to release the lock. */
	public async release(){

		await this._release(this);

	};

}

export class RedLock{

	private readonly clients: RedLockClient[];
	/** The minimum number of clients who must confirm the lock */
	private readonly clientConsensus: number;
	/** The settings for this instance */
	private readonly settings: Readonly<RedLockSettings>;

	public constructor(clients: RedLockClient[], settings: Partial<RedLockSettings> = {}){

		if(clients.length === 0){
			throw new Error('At least one client is required.');
		}

		this.clients = clients;
		this.clientConsensus = Math.floor(this.clients.length/2)+1;

		this.settings = {
			duration: (typeof settings.duration === 'number' ? settings.duration : defaultSettings.duration),
			retryCount: (typeof settings.retryCount === 'number' ? settings.retryCount : defaultSettings.retryCount),
			retryDelay: (typeof settings.retryDelay === 'number' ? settings.retryDelay : defaultSettings.retryDelay),
			maxHoldTime: (typeof settings.maxHoldTime === 'number' ? settings.maxHoldTime : defaultSettings.maxHoldTime),
			driftFactor: (typeof settings.driftFactor === 'number' ? settings.driftFactor : defaultSettings.driftFactor),
			driftConstant: (typeof settings.driftConstant === 'number' ? settings.driftConstant : defaultSettings.driftConstant),
		};

		this.extend = this.extend.bind(this);
		this.release = this.release.bind(this);

	};

	public async aquire(key: string, settings: Partial<RedLockSettings> = {}){

		//step 1.
		const start = Date.now();
		const uid = randomBytes(20).toString("hex");
		const lockSettings: RedLockSettings = {
			duration: (typeof settings.duration === 'number' ? settings.duration : this.settings.duration),
			retryCount: (typeof settings.retryCount === 'number' ? settings.retryCount : this.settings.retryCount),
			retryDelay: (typeof settings.retryDelay === 'number' ? settings.retryDelay : this.settings.retryDelay),
			maxHoldTime: (typeof settings.maxHoldTime === 'number' ? settings.maxHoldTime : this.settings.maxHoldTime),
			driftFactor: (typeof settings.driftFactor === 'number' ? settings.driftFactor : this.settings.driftFactor),
			driftConstant: (typeof settings.driftConstant === 'number' ? settings.driftConstant : this.settings.driftConstant),
		};

		let success = false;

		for(let tries = lockSettings.retryCount+1; tries > 0; tries--){

			//step 2.
			const results = await Promise.allSettled(
				this.clients.map((client)=>this.runLua(client, aquireLockLua, [key], [uid, lockSettings.duration.toString()]))
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

			//if there was not a consensus, try removing and wait to retry.
			await Promise.all([
				this.noThrowQuickRelease({key, uid}),//step 5.
				this.randomSleep(lockSettings.retryDelay)
			]);

		}

		if(!success){

			//was not successful
			//step 5.
			await this.noThrowQuickRelease({key, uid});

			throw new Error('Failed to aquire a lock consensus.');

		}

		//steps 3 & 4.
		//parsedDuration - execution time - drift;
		const remainingTime = Math.floor(lockSettings.duration - (Date.now() - start) - (lockSettings.driftFactor * lockSettings.duration) - lockSettings.driftConstant);

		if(remainingTime <= 0){

			//took too long
			//step 5.
			await this.noThrowQuickRelease({key, uid});

			throw new Error('Took too long to aquire the lock.');

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

	};

	private async extend(lock: Lock){
	
		//need to check remaining time, max hold time, and init time.
		extendLockLua;
		
		return 0;
	
	
	};

	/** Attempts to release the provided lock */
	private async release(lock: Lock){

		const results = await Promise.allSettled(
			this.clients.map((client)=>this.runLua(client, removeLockLua, [lock.key], [lock.uid]))
		);

		for(let i = 0; i < results.length; i++){

			const result = results[i]!;//for TS
			if(result.status === 'rejected'){

				throw result.reason;

			}

		}

	};

	/** Executes the given Lua & arguments on the provided client */
	private async runLua(
		client: RedLockClient,
		lua: typeof aquireLockLua | typeof extendLockLua | typeof removeLockLua,
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

	};

	/** Checks if a given value is an Error and is a `NOSCRIPT` error. */
	private isNoScriptError(e: any){

		return (
			(e instanceof Error) &&
			/NOSCRIPT/i.test(e.message)
		);

	}

	/** A typeguard for determining which client this is */
	private isIORedisClient(client: RedLockClient):client is IORedisClient{

		return (
			('eval' in client) &&
			('evalsha' in client)
		);

	};

	/** A typeguard for determining which client this is */
	private isNodeRedisClient(client: RedLockClient):client is NodeRedisClient{

		return (
			('eval' in client) &&
			('evalSha' in client)
		);

	};

	/** A helper function to release without an existing `Lock` */
	private async noThrowQuickRelease({key, uid}:{key: string, uid: string}){

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

	};

	/** A helper for random retry timeouts */
	private async randomSleep(maxMS: number){

		await new Promise((res)=>{
			setTimeout(res, Math.floor(Math.random() * maxMS));
		});

	};

}