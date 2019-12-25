const enum MessageType {
    Initiate,
    Request,
    Resolve,
    ResolveIterator,
    RequestNextIterator,
    ResolveNextIterator,
    Reject,
};

type RpcMessage = {
    _rpcType: MessageType.Initiate;
    methods: string[];
} | {
    _rpcType: MessageType.Request;
    reqId: number;
    method: string;
    args: any[];
} | {
    _rpcType: MessageType.Resolve;
    reqId: number;
    value: any;
} | {
    _rpcType: MessageType.ResolveIterator;
    reqId: number;
} | {
    _rpcType: MessageType.RequestNextIterator;
    reqId: number;
} | {
    _rpcType: MessageType.ResolveNextIterator;
    reqId: number;
    done?: boolean;
    value: any;
} | {
    _rpcType: MessageType.Reject;
    reqId: number;
    error: any;
};

interface Request {
    resolve: Function;
    reject: Function;
}

type Constructor<R, H> = new (r?: R) => H;

/**
 * Initiate an RPC connection using the Worker postMessage and event listeners
 * @param worker {Worker} The Worker instance
 * @param ctor {Function} A class that contains the methods to expose to the other end
 * @returns { host, remote } The host and remote objects
 */
export default function <R = any, H = any>(worker: Worker, ctor?: Constructor<R, H>) {
    return new Promise<{ host: H, remote: R }>((resolve, reject) => {
        const requests = new Map<number, Request>();
        const asyncIterators = new Map<number, AsyncIterator<any>>();
        let lastReqId = 0;
        let host: H;

        async function messageListener(ev: MessageEvent) {
            const msg: RpcMessage = ev.data;
            if (msg == null) {
                return;
            }

            switch (msg._rpcType) {
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
                                        _rpcType: MessageType.Request,
                                        reqId,
                                        method,
                                        args,
                                    });
                                });

                                result[Symbol.asyncIterator] = async function* () {
                                    await result;
                                    while (true) {
                                        postMessage(worker, {
                                            _rpcType: MessageType.RequestNextIterator,
                                            reqId,
                                        });

                                        const { done, value } = await new Promise((resolve, reject) => {
                                            req.resolve = resolve;
                                            req.reject = reject;
                                        });

                                        if (done) {
                                            return;
                                        } else {
                                            yield value;
                                        }
                                    }
                                };

                                return result;
                            }
                        }

                        host = ctor ? new ctor(remote) : {} as any;
                        resolve({ host, remote });
                    }

                    break;
                }
                case MessageType.Request: {
                    try {
                        const fn: Function = (host as any)[msg.method];
                        const result = await fn.apply(host, msg.args);
                        if (result && result[Symbol.asyncIterator]) {
                            asyncIterators.set(msg.reqId, result[Symbol.asyncIterator]());
                            postMessage(worker, {
                                _rpcType: MessageType.ResolveIterator,
                                reqId: msg.reqId,
                            });
                        } else {
                            postMessage(worker, {
                                _rpcType: MessageType.Resolve,
                                reqId: msg.reqId,
                                value: result,
                            });
                        }
                    } catch (err) {
                        postError(worker, msg.reqId, err);
                    }

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
                case MessageType.Reject: {
                    const req = requests.get(msg.reqId);
                    if (req !== undefined) {
                        req.reject(msg.error);
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
                    let isDone: boolean | undefined;
                    try {
                        const iter = asyncIterators.get(msg.reqId);
                        if (iter === undefined) {
                            throw new Error(`No async iterators found for request ${msg.reqId}`);
                        }

                        const { done, value } = await iter.next();
                        isDone = done;
                        postMessage(worker, {
                            _rpcType: MessageType.ResolveNextIterator,
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

function postMessage(worker: Worker, msg: RpcMessage) {
    worker.postMessage(msg);
}

function postError(worker: Worker, reqId: number, err: any) {
    postMessage(worker, {
        _rpcType: MessageType.Reject,
        reqId,
        error: {
            message: err.message,
        },
    });
}

function postInitiate(worker: Worker, ctor?: Constructor<any, any>) {
    postMessage(worker, {
        _rpcType: MessageType.Initiate,
        methods: ctor ? Object.getOwnPropertyNames(ctor.prototype) : [],
    });
}
