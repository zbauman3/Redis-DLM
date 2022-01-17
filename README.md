# node-redlock
A simple package implementing the RedLock algorithm, using either [node-redis](https://www.npmjs.com/package/redis) or [ioredis](https://www.npmjs.com/package/ioredis) clients.

## The RedLock algorithm
A detailed overview of the RedLock algorithm can be read on the [redis.io](https://redis.io/topics/distlock) website. Quoting the site, a general overview is as follows:

> In order to acquire the lock (on N instances, 5 here), the client performs the following operations:
> 1. It gets the current time in milliseconds.
> 2. It tries to acquire the lock in all the N instances sequentially, using the same key name and random value in all the instances. During step 2, when setting the lock in each instance, the client uses a timeout which is small compared to the total lock auto-release time in order to acquire it. For example if the auto-release time is 10 seconds, the timeout could be in the ~ 5-50 milliseconds range. This prevents the client from remaining blocked for a long time trying to talk with a Redis node which is down: if an instance is not available, we should try to talk with the next instance ASAP.
> 3. The client computes how much time elapsed in order to acquire the lock, by subtracting from the current time the timestamp obtained in step 1. If and only if the client was able to acquire the lock in the majority of the instances (at least 3), and the total time elapsed to acquire the lock is less than lock validity time, the lock is considered acquired.
> 4. If the lock was acquired, its validity time is considered to be the initial validity time minus the time elapsed, as computed in step 3.
> 5. If the client failed to acquire the lock for some reason (either it was not able to lock N/2+1 instances or the validity time is negative), it will try to unlock all the instances (even the instances it believed it was not able to lock).

This library makes some minor changes to the algorithm, notably:
1. Since this library uses clients that are provided to it, there is no good mechanism for implementing request timeouts as stated in step 2 of the algorithm. All requests are sent at the same time and awaited together via `Promise.allSettled([ ...requests ])`.
2. As stated in the ["Safety arguments"](https://redis.io/topics/distlock#safety-arguments) section, a drift factor and drift constant are also subtracted in step 3 of the algorithm. This has the effect of making the lock shorter (usually single milliseconds) in the name of safety.
3. Lock extensions are added as described in the ["Making the algorithm more reliable: Extending the lock"](https://redis.io/topics/distlock#making-the-algorithm-more-reliable-extending-the-lock) section.
4. Auto retries are implemented, as described in the ["Retry on failure"](https://redis.io/topics/distlock#retry-on-failure) section.