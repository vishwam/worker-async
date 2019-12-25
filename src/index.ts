const enum MessageType {
    Initiate,
    Request,
    Resolve,
    ResolveIterator,
    RequestNextIterator,
    ResolveNextIterator,
    CancelIterator,
    Reject,
};

type Message = {
    _type: MessageType.Initiate;
    methods: string[];
} | {
    _type: MessageType.Request;
    reqId: number;
    method: string;
    args: any[];
} | {
    _type: MessageType.Resolve;
    reqId: number;
    value: any;
} | {
    _type: MessageType.ResolveIterator;
    reqId: number;
} | {
    _type: MessageType.RequestNextIterator;
    reqId: number;
} | {
    _type: MessageType.ResolveNextIterator;
    reqId: number;
    done?: boolean;
    value: any;
} | {
    _type: MessageType.CancelIterator;
    reqId: number;
} | {
    _type: MessageType.Reject;
    reqId: number;
    error: any;
};

interface Request {
    resolve: Function;
    reject: Function;
}

type Constructor<Remote, Host> = new (remote?: Remote) => Host;

/**
 * Initiate an RPC connection using the Worker postMessage and event listeners
 * @param worker {Worker} The Worker instance
 * @param ctor {Function} A class that contains the methods to expose to the other end
 * @returns { remote, host } The host and remote objects
 */
export default function promisify<Remote = any, Host = any>(worker: Worker, ctor?: Constructor<Remote, Host>) {
    return new Promise<{ remote: Remote; host: Host }>((resolve, reject) => {
        const requests = new Map<number, Request>();
        const asyncIterators = new Map<number, AsyncIterator<any>>();
        let lastReqId = 0;
        let host: Host;

        function messageListener(ev: MessageEvent) {
            const msg: Message = ev.data;
            if (msg == null) {
                return;
            }

            switch (msg._type) {
                case MessageType.Initiate: {
                    if (host === undefined) {
                        const remote: any = {};
                        for (const method of msg.methods) {
                            remote[method] = (...args: any[]) => {
                                const reqId = lastReqId++;
                                let req: Request;
                                const result: any = new Promise((resolve, reject) => {
                                    req = { resolve, reject };
                                    requests.set(reqId, req);
                                    postMessage(worker, {
                                        _type: MessageType.Request,
                                        reqId,
                                        method,
                                        args,
                                    });
                                });

                                result[Symbol.asyncIterator] = (): AsyncIterator<any> => {
                                    let isIteratorResolved = false;
                                    return {
                                        next: async () => {
                                            if (!isIteratorResolved) {
                                                await result; // wait for the ResolveIterator message
                                                isIteratorResolved = true;
                                            }
                                            
                                            // request the next item:
                                            postMessage(worker, {
                                                _type: MessageType.RequestNextIterator,
                                                reqId,
                                            });
    
                                            // return a promise for the next reply to this request:
                                            return new Promise((resolve, reject) => {
                                                req.resolve = resolve;
                                                req.reject = reject;
                                            });
                                        },
                                        return: async value => {
                                            // if the consumer bailed out early, send a cencellation message
                                            // to clean up on the other side:
                                            requests.delete(reqId);
                                            postMessage(worker, {
                                                _type: MessageType.CancelIterator,
                                                reqId,
                                            });
                                            
                                            return { done: true, value: await value };
                                        },
                                        throw: err => {
                                            // if the consumer threw an exception while iterating, clean up:
                                            requests.delete(reqId);
                                            postMessage(worker, {
                                                _type: MessageType.CancelIterator,
                                                reqId,
                                            });

                                            throw err;
                                        },
                                    };
                                };

                                return result;
                            }
                        }

                        host = ctor ? new ctor(remote) : {} as any;
                        resolve({ remote, host });
                    }

                    break;
                }
                case MessageType.Request: {
                    (async () => {
                        try {
                            const fn: Function = (host as any)[msg.method];
                            const result = await fn.apply(host, msg.args);
                            if (result && result[Symbol.asyncIterator]) {
                                asyncIterators.set(msg.reqId, result[Symbol.asyncIterator]());
                                postMessage(worker, {
                                    _type: MessageType.ResolveIterator,
                                    reqId: msg.reqId,
                                });
                            } else {
                                postMessage(worker, {
                                    _type: MessageType.Resolve,
                                    reqId: msg.reqId,
                                    value: result,
                                });
                            }
                        } catch (err) {
                            postError(worker, msg.reqId, err);
                        }
                    })();
                    break;
                }
                case MessageType.Resolve: {
                    const req = requests.get(msg.reqId);
                    if (req !== undefined) {
                        req.resolve(msg.value);
                        requests.delete(msg.reqId);
                    }

                    break;
                }
                case MessageType.ResolveIterator: {
                    const req = requests.get(msg.reqId);
                    if (req !== undefined) {
                        req.resolve();
                    }
                    break;
                }
                case MessageType.RequestNextIterator: {
                    (async () => {
                        let isDone: boolean | undefined;
                        try {
                            const iter = asyncIterators.get(msg.reqId);
                            if (iter === undefined) {
                                throw new Error(`No async iterators found for request ${msg.reqId}`);
                            }

                            const { done, value } = await iter.next();
                            isDone = done;
                            postMessage(worker, {
                                _type: MessageType.ResolveNextIterator,
                                reqId: msg.reqId,
                                done,
                                value,
                            });
                        } catch (err) {
                            postError(worker, msg.reqId, err);
                            isDone = true;
                        }

                        if (isDone) {
                            asyncIterators.delete(msg.reqId);
                        }
                    })();
                    break;
                }
                case MessageType.ResolveNextIterator: {
                    const req = requests.get(msg.reqId);
                    if (req !== undefined) {
                        req.resolve(msg);
                        if (msg.done) {
                            requests.delete(msg.reqId);
                        }
                    }

                    break;
                }
                case MessageType.CancelIterator: {
                    const iter = asyncIterators.get(msg.reqId);
                    asyncIterators.delete(msg.reqId);
                    iter?.return?.(); // tell iterator that we're returning early
                    break;
                }
                case MessageType.Reject: {
                    const req = requests.get(msg.reqId);
                    if (req !== undefined) {
                        req.reject(msg.error);
                        requests.delete(msg.reqId);
                    }
                    break;
                }
            }
        }

        worker.addEventListener('message', messageListener, { passive: true });
        worker.addEventListener('error', ev => {
            if (host === undefined) {
                worker.removeEventListener('message', messageListener);
                reject(ev.error);
            }
        }, { once: true, passive: true });

        postInitiate(worker, ctor);
    });
}

function postMessage(worker: Worker, msg: Message) {
    worker.postMessage(msg);
}

function postError(worker: Worker, reqId: number, err: any) {
    postMessage(worker, {
        _type: MessageType.Reject,
        reqId,
        error: {
            message: err.message,
        },
    });
}

function postInitiate(worker: Worker, ctor?: Constructor<any, any>) {
    postMessage(worker, {
        _type: MessageType.Initiate,
        methods: ctor ? Object.getOwnPropertyNames(ctor.prototype) : [],
    });
}
