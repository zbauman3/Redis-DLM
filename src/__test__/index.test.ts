import LockManager, { Lock, defaultSettings } from "../index";
import LockManagerError from "../LockManagerError";
import IORedis, { Cluster as IORedisCluster } from "ioredis";
import { createClient, createCluster } from "redis";
import { randomBytes } from "crypto";
import { createHash } from "crypto";

//Running inside docker, so somtimes these are slow.
jest.setTimeout(60*2*1000);

//Updated with public versions for testing
class TestLock extends Lock{

	public get pub_expireTime(){ return this.expireTime; }
	public get pub__extend(){ return this._extend; }
	public get pub__release(){ return this._release; }

}

//Updated with public versions for testing.
//Added mocks for checking if functions were called/mocking results.
class TestLockManager extends LockManager{

	public get pub_clients(){ return this.clients; }
	public get pub_clientConsensus(){ return this.clientConsensus; }
	public get pub_settings(){ return this.settings; }

	public pub_extend: jest.Mock<ReturnType<LockManager['extend']>, Parameters<LockManager['extend']>>;
	public pub_release: jest.Mock<ReturnType<LockManager['release']>, Parameters<LockManager['release']>>;
	public pub_runLua: jest.Mock<ReturnType<LockManager['runLua']>, Parameters<LockManager['runLua']>>;
	public pub_calculateRemainingTime: jest.Mock<ReturnType<LockManager['calculateRemainingTime']>, Parameters<LockManager['calculateRemainingTime']>>;
	public pub_isNoScriptError: jest.Mock<ReturnType<LockManager['isNoScriptError']>, Parameters<LockManager['isNoScriptError']>>;
	public pub_isIORedisClient: jest.Mock<ReturnType<LockManager['isIORedisClient']>, Parameters<LockManager['isIORedisClient']>>;
	public pub_noThrowQuickRelease: jest.Mock<ReturnType<LockManager['noThrowQuickRelease']>, Parameters<LockManager['noThrowQuickRelease']>>;

	public constructor(...a: ConstructorParameters<typeof LockManager>){

		super(...a);

		this.pub_extend = jest.fn(this.extend.bind(this));
		this.extend = this.pub_extend;

		this.pub_release = jest.fn(this.release.bind(this));
		this.release = this.pub_release;

		this.pub_runLua = jest.fn(this.runLua.bind(this));
		this.runLua = this.pub_runLua;

		this.pub_calculateRemainingTime = jest.fn(this.calculateRemainingTime.bind(this));
		this.calculateRemainingTime = this.pub_calculateRemainingTime;

		this.pub_isNoScriptError = jest.fn(this.isNoScriptError.bind(this));
		this.isNoScriptError = this.pub_isNoScriptError;

		this.pub_isIORedisClient = jest.fn(this.isIORedisClient.bind(this));
		this.isIORedisClient = this.pub_isIORedisClient as unknown as LockManager['isIORedisClient'];//no other good way to do this one

		this.pub_noThrowQuickRelease = jest.fn(this.noThrowQuickRelease.bind(this));
		this.noThrowQuickRelease = this.pub_noThrowQuickRelease;

	}

}

describe('Lock', ()=>{

	//to share between mocks and classes
	const remainingTime = 95;

	//mock functions instead of passing anything from a LockManager class
	const extendFn = jest.fn<ReturnType<ConstructorParameters<typeof Lock>[0]['extend']>, Parameters<ConstructorParameters<typeof Lock>[0]['extend']>>(async ()=>remainingTime);
	const releaseFn = jest.fn<ReturnType<ConstructorParameters<typeof Lock>[0]['release']>, Parameters<ConstructorParameters<typeof Lock>[0]['release']>>(async ()=>{});

	const testValues: ConstructorParameters<typeof Lock>[0] = {
		key: 'abc',
		uid: 'def',
		remainingTime: remainingTime,
		duration: 100,
		maxHoldTime: 100,
		extend: extendFn,
		release: releaseFn,
	};

	beforeEach(()=>{

		extendFn.mockClear();
		releaseFn.mockClear();

	});

	test('Init values are set', ()=>{

		const lock = new TestLock(testValues);

		expect(lock.key).toBe(testValues.key);
		expect(lock.uid).toBe(testValues.uid);
		expect(lock.duration).toBe(testValues.duration);
		expect(lock.remainingTime).toBeLessThanOrEqual(testValues.remainingTime);
		expect(lock.pub_expireTime).toBeLessThanOrEqual(Date.now()+testValues.remainingTime);
		expect(lock.maxHoldTime).toBe(testValues.maxHoldTime);
		expect(lock.pub__extend).toBe(extendFn);
		expect(lock.pub__release).toBe(releaseFn);

	});

	test('extend', async ()=>{

		const lock = new TestLock(testValues);
		const res = await lock.extend();

		expect(extendFn).toHaveBeenCalledTimes(1);
		expect(lock.pub_expireTime).toBeLessThanOrEqual(Date.now()+testValues.remainingTime);
		expect(typeof res).toBe('number');
		expect(res).toBeLessThanOrEqual(testValues.remainingTime);

	});

	test('release', async ()=>{

		const lock = new TestLock(testValues);
		await lock.release();

		expect(releaseFn).toHaveBeenCalledTimes(1);
		expect(lock.pub_expireTime).toBeLessThanOrEqual(Date.now());

	});

});

describe('LockManager', ()=>{

	const ioRedisClusterClients: InstanceType<typeof IORedisCluster>[] = [];
	const ioRedisInstanceClients: InstanceType<typeof IORedis>[] = [];
	const nodeRedisClusterClients: ReturnType<typeof createCluster>[] = [];
	const nodeRedisInstanceClients: ReturnType<typeof createClient>[] = [];
	const allClientGroups = [
		{ name: 'ioRedisClusterClients', clients: ioRedisClusterClients},
		{ name: 'ioRedisInstanceClients', clients: ioRedisInstanceClients},
		{ name: 'nodeRedisClusterClients', clients: nodeRedisClusterClients},
		{ name: 'nodeRedisInstanceClients', clients: nodeRedisInstanceClients},
	] as const;

	const clearClients = async ()=>{

		await Promise.all([
			...ioRedisClusterClients.map((client)=>client.quit()),
			...ioRedisInstanceClients.map((client)=>client.quit()),
			...nodeRedisClusterClients.map((client)=>client.disconnect()),
			...nodeRedisInstanceClients.map((client)=>client.disconnect())
		]);

		ioRedisClusterClients.splice(0);
		ioRedisInstanceClients.splice(0);
		nodeRedisClusterClients.splice(0);
		nodeRedisInstanceClients.splice(0);

	};

	beforeAll(async ()=>{

		//all info for clusters/instances is taken from `docker/docker-compose.yml`
	
		interface RedisInstance{ host: string, port: number }
		type RedisCluster = RedisInstance[];
	
		const clusters: RedisCluster[] = [
			[
				{ host: 'redisNode0', port: 6379 },
				{ host: 'redisNode1', port: 6379 },
				{ host: 'redisNode2', port: 6379 },
				{ host: 'redisNode3', port: 6379 },
				{ host: 'redisNode4', port: 6379 },
				{ host: 'redisNode5', port: 6379 },
			],
			[
				{ host: 'redisNode6', port: 6379 },
				{ host: 'redisNode7', port: 6379 },
				{ host: 'redisNode8', port: 6379 },
				{ host: 'redisNode9', port: 6379 },
				{ host: 'redisNode10', port: 6379 },
				{ host: 'redisNode11', port: 6379 },
			],
			[
				{ host: 'redisNode12', port: 6379 },
				{ host: 'redisNode13', port: 6379 },
				{ host: 'redisNode14', port: 6379 },
				{ host: 'redisNode15', port: 6379 },
				{ host: 'redisNode16', port: 6379 },
				{ host: 'redisNode17', port: 6379 },
			]
		];
	
		const instances: RedisInstance[] = [
			{ host: 'redisInstance0', port: 6379 },
			{ host: 'redisInstance1', port: 6379 },
			{ host: 'redisInstance2', port: 6379 },
			{ host: 'redisInstance3', port: 6379 },
			{ host: 'redisInstance4', port: 6379 },
		];

		try{

			ioRedisClusterClients.push(
				...clusters.map((clusterConf, i)=>{

					const cluster = new IORedisCluster(clusterConf.map((conf)=>(conf)));
					cluster.on('error', (e)=>{ console.error(`IORedisCluster ${i} error: ${e}`); });
					cluster.on('node error', (e)=>{ console.error(`IORedisCluster ${i} error: ${e}`); });
					return cluster;

				})
			);

			ioRedisInstanceClients.push(
				...instances.map((conf, i)=>{

					const redInstance = new IORedis(conf);
					redInstance.on('error', (e)=>{ console.error(`IORedis ${i} error: ${e}`); });
					return redInstance;

				})
			);

			nodeRedisClusterClients.push(
				...clusters.map((clusterConf, i)=>{

					const cluster = createCluster({ rootNodes: clusterConf.map((conf)=>({ socket: conf })) });
					cluster.on('error', (e)=>{ console.error(`NodeRedisCluster ${i} error: ${e}`); });
					return cluster;

				})
			);

			for(let i = 0; i < nodeRedisClusterClients.length; i++){
				await nodeRedisClusterClients[i]!.connect();
			}

			nodeRedisInstanceClients.push(
				...instances.map((instanceConf, i)=>{

					const redInstance = createClient({ socket: instanceConf });
					redInstance.on('error', (e)=>{ console.error(`NodeRedis ${i} error: ${e}`); });
					return redInstance;

				})
			);

			for(let i = 0; i < nodeRedisInstanceClients.length; i++){
				await nodeRedisInstanceClients[i]!.connect();
			}

		}catch(e){

			await clearClients();

			throw e;

		}

	});

	afterAll(async ()=>{

		//close open handles
		await clearClients();

	});

	beforeEach(async ()=>{

		await Promise.all([
			...ioRedisClusterClients.map((cluster)=>cluster.flushall()),
			...ioRedisInstanceClients.map((instance)=>instance.flushall()),
			...nodeRedisClusterClients.reduce<Promise<any>[]>((acc, cluster)=>([
				...acc,
				...cluster.getMasters().map((mast)=>mast.client.flushAll())
			]), []),
			...nodeRedisInstanceClients.map((instance)=>(instance.flushAll())),
		]);

	});

	//generate tests inside a loop so that we do the same tests across all client types
	for(let i = 0; i < allClientGroups.length; i++){

		const {name, clients} = allClientGroups[i]!;

		test(`Init values are set - ${name}`, async ()=>{

			//test clients, consensus, default settings
			const lockManager1 = new TestLockManager(clients);
			expect(lockManager1.pub_clients).toHaveLength(clients.length);
			expect(lockManager1.pub_clientConsensus).toBe( Math.floor(clients.length/2)+1 );
			expect(lockManager1.pub_settings.duration).toBe(defaultSettings.duration);
			expect(lockManager1.pub_settings.retryCount).toBe(defaultSettings.retryCount);
			expect(lockManager1.pub_settings.retryDelay).toBe(defaultSettings.retryDelay);
			expect(lockManager1.pub_settings.maxHoldTime).toBe(defaultSettings.maxHoldTime);
			expect(lockManager1.pub_settings.driftFactor).toBe(defaultSettings.driftFactor);
			expect(lockManager1.pub_settings.driftConstant).toBe(defaultSettings.driftConstant);

			//custom settings
			const lockManager2 = new TestLockManager(clients, {
				duration: 5,
				retryCount: 4,
				retryDelay: 3,
				maxHoldTime: 2,
				driftFactor: 1,
				driftConstant: 0,
			});
			expect(lockManager2.pub_settings.duration).toBe(5);
			expect(lockManager2.pub_settings.retryCount).toBe(4);
			expect(lockManager2.pub_settings.retryDelay).toBe(3);
			expect(lockManager2.pub_settings.maxHoldTime).toBe(2);
			expect(lockManager2.pub_settings.driftFactor).toBe(1);
			expect(lockManager2.pub_settings.driftConstant).toBe(0);

		});

		test(`aquire - Single try - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);

			clients.forEach(()=>{
				lockManager.pub_runLua.mockResolvedValueOnce('OK');
			});

			const randomKey = randomBytes(20).toString("hex");
			const res = await lockManager.aquire(randomKey, {
				duration: 12345,
				maxHoldTime: 67890
			});

			expect(res).toBeInstanceOf(Lock);
			expect(res.key).toBe(randomKey);
			expect(typeof res.uid).toBe('string');
			expect(res.duration).toBe(12345);
			expect(res.maxHoldTime).toBe(67890);
			expect(res.startTime).toBeLessThanOrEqual(Date.now());
			expect(res.remainingTime).toBeLessThanOrEqual(res.duration);
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_noThrowQuickRelease).toHaveBeenCalledTimes(0);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`aquire - Three tries, first two fail. - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);

			for (let i = 1; i <= clients.length*3; i++) {

				if(i <= clients.length*2){
					lockManager.pub_runLua.mockRejectedValueOnce(new Error('Fail'));
				}else{
					lockManager.pub_runLua.mockResolvedValueOnce('OK');
				}
				
			}

			lockManager.pub_noThrowQuickRelease.mockResolvedValueOnce();
			lockManager.pub_noThrowQuickRelease.mockResolvedValueOnce();

			const randomKey = randomBytes(20).toString("hex");
			const res = await lockManager.aquire(randomKey, {
				retryCount: 2
			});

			expect(res).toBeInstanceOf(Lock);
			expect(res.key).toBe(randomKey);
			expect(typeof res.uid).toBe('string');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length*3);
			expect(lockManager.pub_noThrowQuickRelease).toHaveBeenCalledTimes(2);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`aquire - Single try, minimum consensus. - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);

			for(let i = 1; i <= clients.length; i++){

				if(i < Math.floor(clients.length/2)+1){
					lockManager.pub_runLua.mockRejectedValueOnce(new Error('Fail'));
				}else{
					lockManager.pub_runLua.mockResolvedValueOnce('OK');
				}

			}

			const randomKey = randomBytes(20).toString("hex");
			const res = await lockManager.aquire(randomKey).catch((e)=>e);

			expect(res).toBeInstanceOf(Lock);
			expect(res.key).toBe(randomKey);
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_noThrowQuickRelease).toHaveBeenCalledTimes(0);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`aquire - Single try, no consensus. - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);

			for(let i = 1; i <= clients.length; i++){

				if(i <= Math.floor(clients.length/2)+1){
					lockManager.pub_runLua.mockRejectedValueOnce(new Error('Fail'));
				}else{
					lockManager.pub_runLua.mockResolvedValueOnce('OK');
				}
				
			}

			lockManager.pub_noThrowQuickRelease.mockResolvedValueOnce();

			const randomKey = randomBytes(20).toString("hex");
			const res = await lockManager.aquire(randomKey).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('noConsensus');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_noThrowQuickRelease).toHaveBeenCalledTimes(1);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(0);

		});

		test(`aquire - Single try, took too long. - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);

			for(let i = 1; i <= clients.length; i++){
				lockManager.pub_runLua.mockResolvedValueOnce('OK');
			}

			lockManager.pub_calculateRemainingTime.mockReturnValueOnce(0);
			lockManager.pub_noThrowQuickRelease.mockResolvedValueOnce();

			const randomKey = randomBytes(20).toString("hex");
			const res = await lockManager.aquire(randomKey).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('tooLongToAquire');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_noThrowQuickRelease).toHaveBeenCalledTimes(1);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`extend - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: lockManager.pub_calculateRemainingTime(Date.now(), defaultSettings),
				duration: defaultSettings.duration,
				maxHoldTime: defaultSettings.maxHoldTime,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			//because it was called above
			lockManager.pub_calculateRemainingTime.mockClear();

			clients.forEach(()=>{
				lockManager.pub_runLua.mockResolvedValueOnce(1);
			});

			const res = await lockManager.pub_extend(lock);

			expect(typeof res).toBe('number');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`extend - No remaining time - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: 0,
				duration: defaultSettings.duration,
				maxHoldTime: defaultSettings.maxHoldTime,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			const res = await lockManager.pub_extend(lock).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('lockNotValid');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(0);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(0);

		});

		test(`extend - Over max hold time - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: defaultSettings.duration,
				duration: defaultSettings.duration,
				maxHoldTime: 0,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			const res = await lockManager.pub_extend(lock).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('excededMaxHold');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(0);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(0);

		});

		test(`extend - Would excede max hold time - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: defaultSettings.duration,
				duration: defaultSettings.duration,
				maxHoldTime: defaultSettings.duration-1,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			const res = await lockManager.pub_extend(lock).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('wouldExcededMaxHold');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(0);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(0);

		});

		test(`extend - No consensus -  ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: defaultSettings.duration,
				duration: defaultSettings.duration,
				maxHoldTime: defaultSettings.maxHoldTime,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			for(let i = 1; i <= clients.length; i++){

				if(i <= Math.floor(clients.length/2)+1){
					lockManager.pub_runLua.mockRejectedValueOnce(new Error('Fail'));
				}else{
					lockManager.pub_runLua.mockResolvedValueOnce(1);
				}
				
			}

			const res = await lockManager.pub_extend(lock).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('noConsensus');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(0);

		});

		test(`extend - Minimum consensus -  ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: defaultSettings.duration,
				duration: defaultSettings.duration,
				maxHoldTime: defaultSettings.maxHoldTime,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			for(let i = 1; i <= clients.length; i++){

				if(i < Math.floor(clients.length/2)+1){
					lockManager.pub_runLua.mockRejectedValueOnce(new Error('Fail'));
				}else{
					lockManager.pub_runLua.mockResolvedValueOnce(1);
				}
				
			}

			const res = await lockManager.pub_extend(lock);

			expect(typeof res).toBe('number');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`extend - Took too long - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);
			const lock = new TestLock({
				key: randomBytes(20).toString("hex"),
				uid: randomBytes(20).toString("hex"),
				remainingTime: defaultSettings.duration,
				duration: defaultSettings.duration,
				maxHoldTime: defaultSettings.maxHoldTime,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			});

			clients.forEach(()=>{
				lockManager.pub_runLua.mockResolvedValueOnce(1);
			});

			lockManager.pub_calculateRemainingTime.mockReturnValueOnce(0);

			const res = await lockManager.pub_extend(lock).catch((e)=>e);

			expect(res).toBeInstanceOf(LockManagerError);
			expect(res.messageName).toBe('tooLongToAquire');
			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);
			expect(lockManager.pub_calculateRemainingTime).toHaveBeenCalledTimes(1);

		});

		test(`release - ${name}`, async ()=>{

			const lockManager = new TestLockManager(clients);

			clients.forEach(()=>{
				lockManager.pub_runLua.mockResolvedValueOnce('Deleted');
			});

			await lockManager.pub_release(new Lock({
				key: '123',
				uid: '456',
				remainingTime: 0,
				duration: 0,
				maxHoldTime: 0,
				extend: lockManager.pub_extend.bind(lockManager),
				release: lockManager.pub_release.bind(lockManager),
			}));

			expect(lockManager.pub_runLua).toHaveBeenCalledTimes(clients.length);

		});

		test(`runLua - ${name}`, async ()=>{

			//generate a random value to keep this script unique
			const testLuaScript = `local test = "${randomBytes(20).toString("hex")}"; return redis.status_reply("OK")`;
			const testLuaSha1 = createHash("sha1").update(testLuaScript).digest("hex");

			const lockManager = new TestLockManager(clients);

			for(let i = 0; i < clients.length; i++){

				//clear these so i can check them each loop
				lockManager.pub_isIORedisClient.mockClear();
				lockManager.pub_isNoScriptError.mockClear();

				const client = clients[i]!;

				const originalEval = client.eval;
				const originalEvalsha = ('evalsha' in client
					? client.evalsha
					: client.evalSha
				);

				//mock the client so i can validate what is called
				const evalSpy = jest.spyOn(client, 'eval');
				const evalshaSpy = ('evalsha' in client
					? jest.spyOn(client, 'evalsha')
					: jest.spyOn(client, 'evalSha')
				);

				const res1 = await lockManager.pub_runLua(client, {script: testLuaScript, sha1: testLuaSha1}, [], []);

				expect(res1).toBe('OK');
				expect(evalshaSpy).toHaveBeenCalledTimes(1);
				expect(evalSpy).toHaveBeenCalledTimes(1);
				expect(lockManager.pub_isIORedisClient).toHaveBeenCalledTimes(2);
				expect(lockManager.pub_isNoScriptError).toHaveBeenCalledTimes(1);
				expect(lockManager.pub_isNoScriptError.mock.results[0]?.value).toBe(true);

				/**
				 * @todo this can't be done directly on cluster. The script is not replicated to all nodes...
				 * This will need to be updated eventually.
				 */
				if(name !== 'ioRedisClusterClients' && name !== 'nodeRedisClusterClients'){

					const res2 = await lockManager.pub_runLua(client, {script: testLuaScript, sha1: testLuaSha1}, [], []);
	
					expect(res2).toBe('OK');
					expect(evalshaSpy).toHaveBeenCalledTimes(2);
					expect(evalSpy).toHaveBeenCalledTimes(1);
					expect(lockManager.pub_isIORedisClient).toHaveBeenCalledTimes(3);
					expect(lockManager.pub_isNoScriptError).toHaveBeenCalledTimes(1);


				}

				evalSpy.mockReset();
				evalshaSpy.mockReset();

				//I was having issue where the mock was not resetting. This fixes it.
				client.eval = originalEval;
				if('evalsha' in client){
					//@ts-ignore
					client.evalsha = originalEvalsha;
				}else{
					//@ts-ignore
					client.evalSha = originalEvalsha;
				}
				
			}

		});

		test(`isNoScriptError - ${name}`, async ()=>{

			const lockManager1 = new TestLockManager(clients);

			expect(lockManager1.pub_isNoScriptError(new Error('NOSCRIPT'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('this is a NOSCRIPT'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('NOSCRIPT error'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('this a NOSCRIPT error'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('noscript'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('this is a noscript'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('noscript error'))).toBe(true);
			expect(lockManager1.pub_isNoScriptError(new Error('this a noscript error'))).toBe(true);

			expect(lockManager1.pub_isNoScriptError('this is a error')).toBe(false);
			expect(lockManager1.pub_isNoScriptError(new Error('this is a error'))).toBe(false);

		});

		test(`isIORedisClient - ${name}`, async ()=>{

			const lockManager1 = new TestLockManager(clients);
			expect(lockManager1.pub_isIORedisClient(clients[0]!)).toBe(name === 'ioRedisClusterClients' || name === 'ioRedisInstanceClients' ? true : false);

		});

		test(`noThrowQuickRelease - ${name}`, async ()=>{

			const lockManager1 = new TestLockManager(clients);

			//resolves
			lockManager1.pub_release.mockResolvedValueOnce();
			await lockManager1.pub_noThrowQuickRelease({key: '123', uid: '456'});

			expect(lockManager1.pub_release).toHaveBeenCalledTimes(1);

			//rejects
			lockManager1.pub_release.mockRejectedValueOnce(new Error('Something'));
			await lockManager1.pub_noThrowQuickRelease({key: '123', uid: '456'});

			expect(lockManager1.pub_release).toHaveBeenCalledTimes(2);

		});

		test(`Complete - ${name}`, async ()=>{

			const lockManager = new LockManager(clients);
			const randomKey = randomBytes(20).toString("hex");

			const lock = await lockManager.aquire(randomKey, {  
				duration: 15*1000
			});

			expect(lock.key).toBe(randomKey);
			expect(lock.remainingTime).toBeGreaterThanOrEqual(14*1000);

			await lock.extend({
				duration: 20*1000
			});

			expect(lock.remainingTime).toBeGreaterThanOrEqual(19*1000);

			await lock.release();

		});

		test(`Complete - conflicting locks, no retry - ${name}`, async ()=>{

			expect.assertions(5);

			const lockManager = new LockManager(clients);
			const randomKey = randomBytes(20).toString("hex");

			const lock1 = await lockManager.aquire(randomKey, {
				duration: 2*1000
			});

			expect(lock1.key).toBe(randomKey);
			expect(lock1.remainingTime).toBeGreaterThanOrEqual(1000);

			try{

				await lockManager.aquire(randomKey);

			}catch(e){

				expect(e).toBeInstanceOf(LockManagerError);
				expect((e as LockManagerError).messageName).toBe('noConsensus');

			}

			await new Promise((res)=>setTimeout(res, lock1.remainingTime+1000));

			const lock2 = await lockManager.aquire(randomKey);

			expect(lock2.key).toBe(randomKey);

		});

		test(`Complete - conflicting locks, retries - ${name}`, async ()=>{

			expect.assertions(5);

			const lockManager = new LockManager(clients);
			const randomKey = randomBytes(20).toString("hex");

			const lock1 = await lockManager.aquire(randomKey, {
				duration: 2*1000
			});

			expect(lock1.key).toBe(randomKey);
			expect(lock1.remainingTime).toBeGreaterThanOrEqual(1000);

			try{

				await lockManager.aquire(randomKey);

			}catch(e){

				expect(e).toBeInstanceOf(LockManagerError);
				expect((e as LockManagerError).messageName).toBe('noConsensus');

			}

			await new Promise((res)=>setTimeout(res, lock1.remainingTime));

			const lock2 = await lockManager.aquire(randomKey, {
				retryCount: 5
			});

			expect(lock2.key).toBe(randomKey);

		});

	}

});