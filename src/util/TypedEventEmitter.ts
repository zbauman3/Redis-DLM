import { EventEmitter } from "events";

export interface EmitEvents{
	[k: (string | symbol)]: (...args: any[])=>any
}

export declare interface TypedEventEmitter<T extends EmitEvents>{
	on<U extends keyof T>(event: U, listener: T[U]): this;
    once<U extends keyof T>(event: U, listener: T[U]): this;
    addListener<U extends keyof T>(event: U, listener: T[U]): this;
    prependListener<U extends keyof T>(event: U, listener: T[U]): this;
    prependOnceListener<U extends keyof T>(event: U, listener: T[U]): this;

    off<U extends keyof T>(event: U, listener: T[U]): this;
    removeListener<U extends keyof T>(event: U, listener: T[U]): this;
    removeAllListeners(event?: keyof T): this;
    eventNames<U extends keyof T>(): U[];

    listenerCount(type: keyof T): number;
    listeners<U extends keyof T>(type: U): T[U][];
    rawListeners<U extends keyof T>(type: U): T[U][];

	emit<U extends keyof T>(event: U, ...args: Parameters<T[U]>): boolean;
}

export class TypedEventEmitter<T extends EmitEvents> extends EventEmitter{}