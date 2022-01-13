import { randomBytes } from "crypto";
import { TypedEventEmitter as EventEmitter } from "./util/TypedEventEmitter";
import { resolve as resolvePath } from "path";
import { readFileSync } from 'fs';
import type { Redis, Cluster } from "ioredis";

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
 * `ACTIVE`: The lock is valid \
 * `INACTIVE`: The lock expired or was released \
 * `FAILED`: The lock failed 
 */
export type LockStatus = 'ACTIVE' | 'INACTIVE' | 'FAILED';
export type LockEvents = {
	/** Fired when the lock's expire time is 75% complete. */
	expiring: ()=>void
	/** Fired when the lock has expired or was released. */
	inactive: ()=>void
}

export type RedLockClient = Redis | Cluster;

export const aquireLockLua = readFileSync(resolvePath(__dirname, '../lua/aquireLock.lua'), {encoding: 'utf8'});
export const extendLockLua = readFileSync(resolvePath(__dirname, '../lua/extendLock.lua'), {encoding: 'utf8'});
export const removeLockLua = readFileSync(resolvePath(__dirname, '../lua/removeLock.lua'), {encoding: 'utf8'});

export class Lock extends EventEmitter<LockEvents>{

	public readonly key: string;
	public readonly uid: string;
	public status: LockStatus;
	/** If the lock should auto extend */
	public autoExtend: boolean = false;

	protected expiredTimeout = setTimeout(()=>void 0, 0);//just to set an init value.
	protected expiringTimeout = setTimeout(()=>void 0, 0);//just to set an init value.

	private redLock: RedLock;

	public constructor({
		redLock,
		key,
		uid,
		status,
		duration,
		autoExtend,
	}:{
		redLock: RedLock,
		key: string,
		uid: string,
		status: LockStatus,
		duration: number,
		autoExtend?: boolean,
	}){

		super();

		this.redLock = redLock;
		this.key = key;
		this.uid = uid;
		this.status = status;

		if(typeof autoExtend === 'boolean'){
			this.autoExtend = autoExtend;
		}

		if(this.status === 'ACTIVE'){
			this._updateTimeout(duration);
		}

	};
	
	protected _updateTimeout(duration: number){

		clearTimeout(this.expiredTimeout);
		clearTimeout(this.expiringTimeout);

		if(this.status !== 'ACTIVE'){
			return;
		}

		this.expiredTimeout = setTimeout(()=>{

			if(this.status !== 'ACTIVE'){
				return;
			}

			this.status = 'INACTIVE';
			this.emit('inactive');

		}, duration);

		this.expiringTimeout = setTimeout(()=>{

			if(this.status !== 'ACTIVE'){
				return;
			}

			if(this.autoExtend === true){

				this.extend();

			}else{

				this.emit('expiring');

			}

		}, Math.floor(duration*0.75));

	};

	public async extend(){
		return this.redLock.extend(this);
	};

	public async release(){
		return this.redLock.release(this);
	};

}

export class RedLock extends EventEmitter<{}>{

	protected clients: RedLockClient[];

	public constructor(clients: RedLockClient[]){

		super();

		if(clients.length === 0){
			throw new Error('At least one client is required.');
		}

		this.clients = clients;

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

				const results = await Promise.all(
					this.clients.map((client)=>client.eval(aquireLockLua, 1, key, uid, parsedDuration))
				);

				let success = 0;

				for(let i = 0; i < results.length; i++){
					
					if(results[i] === 'OK'){
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
			const remainingDuration = Math.floor(parsedDuration-(Date.now()-start)-(0.01 * parsedDuration)-2);//duration - duration to execute - drift;
			if(remainingDuration <= 0){

				throw new Error('Took too long to aquire the lock.');

			}

		}catch(e){

			try{

				await this.release(new Lock({
					key,
					uid,
					redLock: this,
					status: 'FAILED',
					duration: 0,
				}));

			}catch(_){ /** noop */ }

			throw e;

		}

	}

	public async release(lock: Lock){};
	public async extend(lock: Lock){};





	static readonly defaults: {
		readonly duration: number
	} = {
		duration: 30000
	};

}