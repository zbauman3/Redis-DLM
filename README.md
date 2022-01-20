# Redis-DLM
A Distributed Lock Manager for Redis, implemented with the [RedLock](https://redis.io/topics/distlock) algorithm, using either [node-redis](https://www.npmjs.com/package/redis) or [ioredis](https://www.npmjs.com/package/ioredis) clients.

## Installation

```bash
npm i redis-dlm
```

## Usage
```typescript
import LockManager from "redis-dlm"

//create a new lock manager
const lockManager = new LockManager([
	/**
	 * ioRedis clients, node-redis clients, or a mix.
	 * Clusters, instances, or a mix.
	 */
]);

//acquire a lock
const lock = await lockManager.acquire('myKey');

//the lock's key
lock.key;
//the lock's unique value
lock.uid;
//the lock's initial duration in milliseconds
lock.duration;
//the lock's max hold time in milliseconds across extends
lock.maxHoldTime;
//the lock's creation time in milliseconds
lock.startTime;
//the time remaining in milliseconds before the lock expires
lock.remainingTime;

//extend the lock
await lock.extend();
//release the lock (or just wait for it to expire).
await lock.release();
```

## Settings
You can pass a settings object to the lock manager's constructor, these will be the default settings used across all new locks.
```typescript
const lockManager = new LockManager(clients, {
	/** The duration of the lock in milliseconds, before the time to acquire is subtracted. Default `10000`. */
	duration: 10000,
	/** The number of times to retry aquiring a lock. Default `0`. */
	retryCount: 0,
	/** The max retry delay in milliseconds. A random time between this and zero will be selected. Default `500`. */
	retryDelay: 500,
	/** The maximum time in milliseconds that a lock should be held across extensions. Default `60000`. */
	maxHoldTime: 60000,
	/** The percent of the duration that should be used as drift, combined with `driftConstant`. Between 0 and 1. Default `0.001`. */
	driftFactor: 0.001,
	/** The fixed number of milliseconds to be used as drift, combined with `duration*driftFactor`. Default `5`. */
	driftConstant: 5,
});
```
You can also pass the same settings object to `acquire`, these will be used as the settings for only this lock.
```typescript
const lock = await lockManager.acquire('myKey', {
	duration: 10000,
	retryCount: 0,
	retryDelay: 500,
	maxHoldTime: 60000,
	driftFactor: 0.001,
	driftConstant: 5,
});
```
Last, you can pass a subset of the settings object to `extend`, these will only be used during this extend. If you do not pass `duration`, the lock's original duration will be used. If you do not pass `driftFactor` or `driftConstant` the default values from the lock manager will be used.
```typescript
await lock.extend({
	duration: 10000,
	driftFactor: 0.001,
	driftConstant: 5,
});
```

## Errors
All errors are generated at the time of function execution, there are no events. A full list of error types can be seen in the [LockManagerError class](https://github.com/zbauman3/Redis-DLM/blob/main/src/LockManagerError.ts).


## The RedLock algorithm
A detailed overview of the RedLock algorithm can be read on the [redis.io](https://redis.io/topics/distlock) website. Quoting the site, a general overview is as follows:

> In order to acquire the lock (on N instances, 5 here), the client performs the following operations:
> 1. It gets the current time in milliseconds.
> 2. It tries to acquire the lock in all the N instances sequentially, using the same key name and random value in all the instances. During step 2, when setting the lock in each instance, the client uses a timeout which is small compared to the total lock auto-release time in order to acquire it. For example if the auto-release time is 10 seconds, the timeout could be in the ~ 5-50 milliseconds range. This prevents the client from remaining blocked for a long time trying to talk with a Redis node which is down: if an instance is not available, we should try to talk with the next instance ASAP.
> 3. The client computes how much time elapsed in order to acquire the lock, by subtracting from the current time the timestamp obtained in step 1. If and only if the client was able to acquire the lock in the majority of the instances (at least 3), and the total time elapsed to acquire the lock is less than lock validity time, the lock is considered acquired.
> 4. If the lock was acquired, its validity time is considered to be the initial validity time minus the time elapsed, as computed in step 3.
> 5. If the client failed to acquire the lock for some reason (either it was not able to lock N/2+1 instances or the validity time is negative), it will try to unlock all the instances (even the instances it believed it was not able to lock).

This package makes some minor changes to the algorithm, notably:
1. Since this package uses clients that are provided to it, there is no good mechanism for implementing request timeouts as stated in step 2 of the algorithm. All requests are sent at the same time and awaited together via `Promise.allSettled(requests)`.
2. As stated in the ["Safety arguments"](https://redis.io/topics/distlock#safety-arguments) section, a drift factor and drift constant are also subtracted in step 3 of the algorithm. This has the effect of making the lock shorter (usually single milliseconds) in the name of safety.
3. Lock extensions are added as described in the ["Making the algorithm more reliable: Extending the lock"](https://redis.io/topics/distlock#making-the-algorithm-more-reliable-extending-the-lock) section.
4. Auto retries are implemented, as described in the ["Retry on failure"](https://redis.io/topics/distlock#retry-on-failure) section.

## Fault Tolerance
If absolute exclusivity is desired for a lock, even after an instance/node crash, extra settings are required for restarting/promoting instances/nodes. See the ["Performance, crash-recovery and fsync"](https://redis.io/topics/distlock#performance-crash-recovery-and-fsync) section of the RedLock documentation for more info.

## Support
Currently this has only been tested on Node.js `16.3.x`. More tests are to come and this section will be updated as I test them.