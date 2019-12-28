const enum MessageType {
    Initiate,
    Request,
    Resolve,
    Reject,
    RequestNextItem,
    CancelIterator,
};

interface InitiateMessage {
    _type: MessageType.Initiate;
    reqId: number;
    methods: string[];
}

interface RequestMessage {
    _type: MessageType.Request;
    reqId: number;
    method: string;
    args: any[];
}

interface ResolveMessage {
    _type: MessageType.Resolve;
    reqId: number;
    result?: any;
}

interface RejectMessage {
    _type: MessageType.Reject;
    reqId: number;
    error: any;
}

interface RequestNextItemMessage {
    _type: MessageType.RequestNextItem;
    reqId: number;
}

interface CancelIteratorMessage {
    _type: MessageType.CancelIterator;
    reqId: number;
}

type Message = InitiateMessage | RequestMessage | ResolveMessage | RejectMessage | RequestNextItemMessage | CancelIteratorMessage;

interface Request {
    resolve: (value?: any) => void;
    reject: (err?: any) => void;
}

export type Constructor<Remote, Host> = new (remote?: Remote) => Host;

export class MessageHandler<Remote, Host> {
    private requests = new Map<number, Request>();
    private asyncIterators = new Map<number, AsyncIterator<any>>();
    private lastReqId = 0;

    private host?: any;
    private remote?: any;
    private initiateError?: Error;

    constructor(
        private postMessage: (msg: Message) => void,
        private hostCtor?: Constructor<Remote, Host>,
    ) {
    }

    handle(msg?: Message) {
        switch (msg?._type) {
            case MessageType.Initiate:
                this.handleInitiate(msg);
                break;
            case MessageType.Request:
                this.handleRequest(msg);
                break;
            case MessageType.Resolve:
            case MessageType.Reject:
                this.handleResponse(msg);
                break;
            case MessageType.RequestNextItem:
                this.handleRequestNextItem(msg);
                break;
            case MessageType.CancelIterator:
                this.handleCancelIterator(msg);
                break;
        }
    }

    async sendInitiate(): Promise<{ host: Host, remote: Remote }> {
        // send an initiate message to the other side:
        const methods = this.hostCtor ? Object.getOwnPropertyNames(this.hostCtor.prototype) : [];
        const reqId = this.newReqId();
        await this.sendRequest({ _type: MessageType.Initiate, reqId, methods });

        // if we failed to initiate on our side, rethrow that error:
        if (this.initiateError) {
            throw this.initiateError;
        } else {
            return { host: this.host, remote: this.remote };
        }
    }

    /** handle initiate message sent by the other side */
    private handleInitiate({ methods, reqId }: InitiateMessage) {
        try {
            // first construct the remote object:
            this.remote = {};
            for (const method of methods) {
                this.remote[method] = (...args: any[]) => this.remoteMethod(method, args);
                // don't use bind - it's much slower than arrow functions in Edge: https://jsperf.com/bind-test9/1
            }

            // then try to construct our host object:
            this.host = this.hostCtor ? new this.hostCtor(this.remote) : {};

            // resolve sendInitiate() on the other side:
            this.postMessage({ _type: MessageType.Resolve, reqId });
        } catch (error) {
            // reject sendInitiate() on the other side:
            this.postMessage({ _type: MessageType.Reject, reqId, error });

            // reject sendInitiate() on the current side:
            this.initiateError = error;
        }
    }

    /** handle request message sent by the other side */
    private async handleRequest({ method, args, reqId }: RequestMessage) {
        try {
            const result = await this.host[method](...args);
            if (result?.[Symbol.asyncIterator]) {
                // `method` is an async generator. Get the iterator:
                const iter = result[Symbol.asyncIterator]();

                // tell the other side that the iterator was resolved:
                this.postMessage({ _type: MessageType.Resolve, reqId });

                // once the message was sent successfully, update the iterators map:
                this.asyncIterators.set(reqId, iter);
            } else {
                // normal method. Resolve the value on the other side:
                this.postMessage({ _type: MessageType.Resolve, reqId, result });
            }
        } catch (error) {
            this.postMessage({ _type: MessageType.Reject, reqId, error });
        }
    }

    /** handle resolve/reject messages sent by the other side */
    private handleResponse(msg: ResolveMessage | RejectMessage) {
        const req = this.requests.get(msg.reqId);
        if (req !== undefined) {
            this.requests.delete(msg.reqId);
            if (msg._type === MessageType.Resolve) {
                req.resolve(msg.result);
            } else {
                req.reject(msg.error);
            }
        }
    }

    private async handleRequestNextItem({ reqId }: RequestNextItemMessage) {
        let isDone: boolean | undefined;
        try {
            const iter = this.asyncIterators.get(reqId);
            if (iter === undefined) {
                throw new Error(`No async iterators found for request ${reqId}`);
            }

            const result = await iter.next();
            isDone = result.done;
            this.postMessage({ _type: MessageType.Resolve, reqId, result });
        } catch (error) {
            this.postMessage({ _type: MessageType.Reject, reqId, error });
            isDone = true;
        }

        if (isDone) {
            this.asyncIterators.delete(reqId);
        }
    }

    private handleCancelIterator({ reqId }: CancelIteratorMessage) {
        const iter = this.asyncIterators.get(reqId);
        if (iter !== undefined) {
            this.asyncIterators.delete(reqId);
            iter.return?.(); // tell iterator that we're returning early
        }
    }

    private remoteMethod(method: string, args: any[]) {
        const reqId = this.newReqId();
        const result: any = this.sendRequest({ _type: MessageType.Request, reqId, method, args });

        // if caller does a `for await` loop over remote.method,
        // we need to return an aync iterator in the result:
        let isIteratorResolved = false;
        result[Symbol.asyncIterator] = (): AsyncIterator<any> => ({
            next: async () => {
                if (!isIteratorResolved) {
                    await result; // wait for the iterator to be resolved
                    isIteratorResolved = true;
                }

                // request the next item (with the same reqId):
                return this.sendRequest({ _type: MessageType.RequestNextItem, reqId });
            },
            return: async value => {
                // if the consumer bailed out early, send a cencellation message
                // to clean up on the other side:
                this.postMessage({ _type: MessageType.CancelIterator, reqId });
                return { done: true, value: await value };
            },
            throw: err => {
                // if the consumer threw an exception while iterating, clean up:
                this.postMessage({ _type: MessageType.CancelIterator, reqId });
                throw err;
            },
        });

        return result;
    }

    private newReqId() {
        return this.lastReqId++;
    }

    private sendRequest(msg: InitiateMessage | RequestMessage | RequestNextItemMessage) {
        // first try to post message to the other side:
        this.postMessage(msg);

        // if post succeeds, add to requests map (picked up by handleResponse):
        return new Promise<any>((resolve, reject) => {
            this.requests.set(msg.reqId, { resolve, reject });
        });
    }
}
