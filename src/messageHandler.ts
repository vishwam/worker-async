const enum MessageType {
    Request,
    Resolve,
    Reject,
    RequestNextItem,
    CancelIterator,
};

interface RequestMessage {
    _type: MessageType.Request;
    reqId: number;
    stack: any[];
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

type Message = RequestMessage | ResolveMessage | RejectMessage | RequestNextItemMessage | CancelIteratorMessage;

interface Request {
    resolve: (value?: any) => void;
    reject: (err?: any) => void;
}

export default class MessageHandler {
    private requests = new Map<number, Request>();
    private asyncIterators = new Map<number, AsyncIterator<any>>();
    private lastReqId = 0;

    constructor(
        private worker: Worker,
        private host?: any,
    ) {
    }

    /** Handles an incoming Message */
    onMessage = (ev: MessageEvent) => {
        const msg: Message = ev.data;
        switch (msg?._type) {
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
            default:
                return;
        }
        
        // this event was intended for us, don't propagate to other listeners: 
        ev.stopImmediatePropagation();
    }

    /** handle request message sent by the other side */
    private async handleRequest({ stack, args, reqId }: RequestMessage) {
        try {
            // get the object and function this request is targeting:
            let thisArg: any;
            let fn: Function = this.host;
            for (const item of stack) {
                // move thisArg and fn to the next item:
                thisArg = fn;
                fn = thisArg[item];
            }
            
            // call the method:
            const result = await fn.apply(thisArg, args);
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
        } catch (err) {
            this.postError(reqId, err);
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
                let { error } = msg;
                if (error != null && typeof error === 'object') {
                    // convert to an Error instance so it's formatted correctly in console/logs:
                    error = Object.assign(new Error(), error);
                }

                req.reject(error);
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
        } catch (err) {
            this.postError(reqId, err);
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

    /**
     * Makes a new remote call
     * @param stack {any[]} Path to the method in the remote object
     * @param args {any[]} The remote method arguments
     * @example await rpc(['increment'], [42])
     * @example await rpc(['child', 'increment'], [42])
     */
    public rpc(stack: any[], args: any[]): Promise<any> {
        const reqId = this.newReqId();
        const result: any = this.sendRequest({ _type: MessageType.Request, reqId, stack, args });

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

    /**
     * Creates a bound RPC function located at the specified path in the remote object.
     * @param stack {any[]} Path to the method in the remote object
     * @returns A function that will execute the remote method with the specified arguments.
     * @example bind('increment')(42)
     */
    public bind(...stack: any[]) {
        return (...args: any[]) => this.rpc(stack, args);
    }

    private newReqId() {
        return this.lastReqId++;
    }

    private sendRequest(msg: RequestMessage | RequestNextItemMessage) {
        // first try to post message to the other side:
        this.postMessage(msg);

        // if post succeeds, add to requests map (picked up by handleResponse):
        return new Promise<any>((resolve, reject) => {
            this.requests.set(msg.reqId, { resolve, reject });
        });
    }

    private postError(reqId: number, err?: any) {
        let error: any;
        try {
            // most browsers can't structure-clone Error instances (and even those 
            // that can -- e.g. Chrome -- don't preserve custom fields like `code`),
            // so do a simple clone ourselves:
            error = clone(err);
        } catch (_) {
            error = {}; // post an empty error instead
        }

        this.postMessage({ _type: MessageType.Reject, reqId, error });
    }

    /** Ensures we only post objects of type Message */
    private postMessage(msg: Message) {
        this.worker.postMessage(msg);
    }
}

function clone(obj: any, clonedObjs = new Map()) {
    switch (typeof obj) {
        case 'bigint':
        case 'boolean':
        case 'number':
        case 'string':
            return obj;
        case 'object': {
            if (obj === null) {
                return obj;
            }

            // check if we've already cloned this object (circular dependency):
            let result = clonedObjs.get(obj);
            if (result === undefined) {
                // create a new clone object:
                result = {};
                clonedObjs.set(obj, result);

                let proto = obj;
                do {
                    for (const name of Object.getOwnPropertyNames(proto)) {
                        if (!(name in result)) {
                            result[name] = clone(obj[name], clonedObjs);
                        }
                    }
                    
                    proto = Object.getPrototypeOf(proto); // climb up the prototype chain
                } while (proto != null);
            }

            return result;
        }
    }
}
