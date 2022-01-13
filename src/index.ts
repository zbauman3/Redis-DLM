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

export type RedLockClient = IORedis | IORedisCluster | ReturnType<typeof createRedisClient> | ReturnType<typeof createRedisCluster>;

/**
 * This represents a lock and its current state. This essentially just holds
 * the information of the lock, handles `autoExtend`, and provides utility
 * functions for extending and releasing.
 * 
 * All times are in milliseconds.
 */
export class Lock{

	/** The time that the lock will expire at */
	protected expireTime = Date.now();
	/** A timeout for the auto extend loop */
	protected extendTimeout = setTimeout(()=>void 0, 0);//just to set an init value.
	/** Bound function from parent. */
	protected readonly _extend: RedLock['extend'];
	/** Bound function from parent. */
	protected readonly _release: RedLock['release'];

	/** The Redis key */
	public readonly key: string;
	/** The Redis key's unique value */
	public readonly uid: string;
	/** The initial duration, used for extend */
	public readonly duration: number;
	/** If this lock will auto extend or not */
	public readonly autoExtend: boolean;
	/** Max time to hold the lock across auto extends. */
	public readonly maxHoldTime: number;
	/** The time that this lock started at */
	public readonly startTime = Date.now();

	/** Set the remaining time (calculates expireTime) */
	protected set remainingTime(duration: number){

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
		autoExtend,
		maxHoldTime,
		extend,
		release,
	}:{
		key: string,
		uid: string,
		duration: number,
		remainingTime: number,
		autoExtend: boolean,
		maxHoldTime: number,
		extend: RedLock['extend'],
		release: RedLock['release']
	}){

		this.key = key;
		this.uid = uid;
		this.duration = duration;
		this.remainingTime = remainingTime;
		this.autoExtend = autoExtend;
		this.maxHoldTime = maxHoldTime;
		this._extend = extend;
		this._release = release;

		if(this.autoExtend === true){
			this.doExtendTimeout();
		}

	};

	/**
	 * This sets a timeout for `remainingTime/2` that calls `extend` then calls
	 * itself again. \
	 * The loop stops when `remainingTime === 0`, `extend` fails, or `release`
	 * is called.
	 */
	protected doExtendTimeout(){

		clearTimeout(this.extendTimeout);

		//leave early
		if(this.remainingTime === 0){
			return;
		}

		this.extendTimeout = setTimeout(async ()=>{

			try{
				await this.extend();
				this.doExtendTimeout();
			}catch(_){}

		}, Math.floor(this.remainingTime/2));

	};

	/** Attempts to extend the lock by `duration` again. */
	public async extend(){

		try{

			this.remainingTime = await this._extend(this);
			return this.remainingTime;

		}catch(e){

			clearTimeout(this.extendTimeout);
			throw e;

		}

	};

	/** Attempts to release the lock. */
	public async release(){

		clearTimeout(this.extendTimeout);
		await this._release(this);

	};

}

export class RedLock{

	protected clients: RedLockClient[];

	public constructor(clients: RedLockClient[]){

		if(clients.length === 0){
			throw new Error('At least one client is required.');
		}

		this.clients = clients;
		this.extend = this.extend.bind(this);
		this.release = this.release.bind(this);

	}

	public async aquireLock({
		key,
		duration,
		retries
	}:{
		key: string,
		/** duration in MS */
		duration?: number,
		retries?: number
	}){

		//step 1.
		const start = Date.now();
		const uid = randomBytes(20).toString("hex");
		const parsedDuration = (typeof duration === 'number' ? duration : RedLock.defaults.duration);

		try{

			if(typeof retries !== 'number' || isNaN(retries) || retries < 0){
				retries = 0;
			}

			//use `>= 0` so we always try once, twice if `retries === 1`, so on.
			while(retries >= 0){

				const results = await Promise.allSettled(
					this.clients.map((client)=>client.eval(aquireLockLua, 1, key, uid, parsedDuration))
				);

				let success = 0;

				for(let i = 0; i < results.length; i++){

					const result = results[i]!//for TS
					if(result.status === 'fulfilled' && result.value === 'OK'){
						success++;
					}
					
				}

				success;
				/**
				 * something like 
				 * `if((this.client.length <= 2 && success === this.client.length) || success >= (this.client.length/2)+1){}`
				 * need a better solution for (n/2)+1
				 * */



				retries--;

			}












			//step 3
			const remainingTime = Math.floor(parsedDuration-(Date.now()-start)-(0.01 * parsedDuration)-2);//duration - duration to execute - drift;
			if(remainingTime <= 0){

				throw new Error('Took too long to aquire the lock.');

			}

			return new Lock({
				key,
				uid,
				remainingTime,
				duration: parsedDuration,
				/** @todo replace */
				autoExtend: false,
				/** @todo replace */
				maxHoldTime: 0,
				extend: this.extend,
				release: this.release,
			});

		}catch(e){

			try{

				await this.release(new Lock({
					key,
					uid,
					duration: 0,
					remainingTime: 0,
					autoExtend: false,
					maxHoldTime: 0,
					extend: this.extend,
					release: this.release,
				}));

			}catch(_){ /** noop */ }

			throw e;

		}

	}

	protected async extend(lock: Lock){
	
		//need to check remaining time, max hold time, and init time.
		extendLockLua;
		
		return 0;
	
	
	};

	protected async release(lock: Lock){

		removeLockLua;

	};





	static readonly defaults: {
		readonly duration: number,
		readonly autoExtend: false,
		readonly maxHoldTime: number,
	} = {
		duration: 30*1000,//30 sec
		autoExtend: false,//no
		maxHoldTime: 60*5*1000//5 min
	};

}