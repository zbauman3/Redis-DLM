import { Lock, RedLock } from "../index";

class TestLock extends Lock{

	public get pub_expireTime(){ return this.expireTime; }
	public get pub__extend(){ return this._extend; }
	public get pub__release(){ return this._release; }

}

class TestRedLock extends RedLock{

	public get pub_clients(){ return this.clients; }
	public get pub_clientConsensus(){ return this.clientConsensus; }
	public get pub_settings(){ return this.settings; }

	public pub_extend: RedLock['extend'];
	public pub_release: RedLock['release'];
	public pub_runLua: RedLock['runLua'];
	public pub_calculateRemainingTime: RedLock['calculateRemainingTime'];
	public pub_isNoScriptError: RedLock['isNoScriptError'];
	public pub_isIORedisClient: RedLock['isIORedisClient'];
	public pub_noThrowQuickRelease: RedLock['noThrowQuickRelease'];

	public constructor(...a: ConstructorParameters<typeof RedLock>){

		super(...a);

		this.pub_extend = this.extend.bind(this);
		this.pub_release = this.release.bind(this);
		this.pub_runLua = this.runLua.bind(this);
		this.pub_calculateRemainingTime = this.calculateRemainingTime.bind(this);
		this.pub_isNoScriptError = this.isNoScriptError.bind(this);
		this.pub_isIORedisClient = this.isIORedisClient.bind(this);
		this.pub_noThrowQuickRelease = this.noThrowQuickRelease.bind(this);

	}

}

describe('Lock', ()=>{

	const duration = 100;
	const remainingTime = duration - 5;

	const extendFn = jest.fn<ReturnType<ConstructorParameters<typeof Lock>[0]['extend']>, Parameters<ConstructorParameters<typeof Lock>[0]['extend']>>(async ()=>remainingTime);
	const releaseFn = jest.fn<ReturnType<ConstructorParameters<typeof Lock>[0]['release']>, Parameters<ConstructorParameters<typeof Lock>[0]['release']>>(async ()=>{});

	const testValues: ConstructorParameters<typeof Lock>[0] = {
		key: 'abc',
		uid: 'def',
		remainingTime: remainingTime,
		duration: duration,
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
		expect(lock.remainingTime).toBeGreaterThanOrEqual(testValues.remainingTime-5);
		expect(lock.pub_expireTime).toBeLessThanOrEqual(Date.now()+testValues.remainingTime);
		expect(lock.pub_expireTime).toBeGreaterThanOrEqual(Date.now()+testValues.remainingTime-5);
		expect(lock.maxHoldTime).toBe(testValues.maxHoldTime);
		expect(lock.pub__extend).toBe(extendFn);
		expect(lock.pub__release).toBe(releaseFn);

	});

	test('extend', async ()=>{

		const lock = new TestLock(testValues);
		const res = await lock.extend();

		expect(extendFn).toHaveBeenCalledTimes(1);
		expect(lock.pub_expireTime).toBeLessThanOrEqual(Date.now()+remainingTime);
		expect(lock.pub_expireTime).toBeGreaterThanOrEqual(Date.now()+remainingTime-5);
		expect(typeof res).toBe('number');
		expect(res).toBeLessThanOrEqual(remainingTime);
		expect(res).toBeGreaterThanOrEqual(remainingTime-5);

	});

	test('release', async ()=>{

		const lock = new TestLock(testValues);
		await lock.release();

		expect(releaseFn).toHaveBeenCalledTimes(1);
		expect(lock.pub_expireTime).toBeLessThanOrEqual(Date.now());
		expect(lock.pub_expireTime).toBeGreaterThanOrEqual(Date.now()-5);

	});

});

describe('RedLock', ()=>{



});