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
    remote: any;
}

interface RequestMessage {
    _type: MessageType.Request;
    reqId: number;
    children: string[];
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

/** A unique identifier to denote remote functions. Use a string because Symbols can't be structured-cloned */ 
const FunctionSymbol = '֍Ꝕ'; 

interface Request {
    resolve: (value?: any) => void;
    reject: (err?: any) => void;
}

export class MessageHandler {
    private requests = new Map<number, Request>();
    private asyncIterators = new Map<number, AsyncIterator<any>>();
    private lastReqId = 0;

    private remote?: any;
    private initiateError?: Error;

    constructor(
        private postMessage: (msg: Message) => void,
        private host?: any,
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
            default:
                return false;
        }

        return true;
    }

    async sendInitiate(): Promise<any> {
        // send an initiate message to the other side:
        const reqId = this.newReqId();
        await this.sendRequest({ _type: MessageType.Initiate, reqId, remote: clone(this.host) });

        // if we failed to initiate on our side, rethrow that error:
        if (this.initiateError) {
            throw this.initiateError;
        } else {
            return this.remote;
        }
    }

    /** handle initiate message sent by the other side */
    private handleInitiate({ remote, reqId }: InitiateMessage) {
        try {
            // first construct the remote object:
            this.remote = remote;
            if (remote != null && typeof remote === 'object') {
                this.hydrateRemote([], remote);
            }

            // resolve sendInitiate() on the other side:
            this.postMessage({ _type: MessageType.Resolve, reqId });
        } catch (error) {
            // reject sendInitiate() on the other side:
            this.postError(reqId, error);

            // reject sendInitiate() on the current side:
            this.initiateError = error;
        }
    }

    /** handle request message sent by the other side */
    private async handleRequest({ children, method, args, reqId }: RequestMessage) {
        try {
            // get to the object this request is targeting:
            const obj = children.reduce((obj, key) => obj[key], this.host);
            
            // call the method:
            const result = await obj[method](...args);
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
            this.postError(reqId, error);
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
                req.reject(deserializeError(msg.error));
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
            this.postError(reqId, error);
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

    private hydrateRemote(children: string[], obj: any, hydratedObjs = new Set()) {
        // mark this obj as seen, in case we run into a circular dependency:
        hydratedObjs.add(obj);

        for (const key of Object.keys(obj)) { // cache keys since we're modifying obj
            const value = obj[key];
            if (value === FunctionSymbol) {
                // hydrate `key` to a remote method:
                // don't use bind - it's much slower than arrow functions in Edge: https://jsperf.com/bind-test9/1
                obj[key] = (...args: any[]) => this.remoteMethod(children, key, args);
            } else if (value != null && typeof value === 'object' && !hydratedObjs.has(value)) {
                // if we haven't see this object before, hydrate it:
                this.hydrateRemote(children.concat(key), value, hydratedObjs);
            }
        }
    }

    private remoteMethod(children: string[], method: string, args: any[]) {
        const reqId = this.newReqId();
        const result: any = this.sendRequest({ _type: MessageType.Request, reqId, children, method, args });

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

    private postError(reqId: number, err: any) {
        try {
            this.postMessage({ _type: MessageType.Reject, reqId, error: serializeError(err) });
        } catch (err) {
            // if there was an error sending the message, try re-sending with new error:
            this.postMessage({ _type: MessageType.Reject, reqId, error: serializeError(err) });
            throw err;
        }
    }
}

function serializeError(err?: any) {
    if (err instanceof Error) {
        // most browsers can't structure-clone Error instances (and even those 
        // that can -- e.g. Chrome -- don't preserve custom fields like `code`),
        // so do a simple clone ourselves:
        const result = clone(err, false);
        
        // add marker to denote this is our serialization:
        result._type = MessageType.Reject; 
        
        // copy native fields that don't always show up as object properties:
        result.message = err.message,
        result.stack = err.stack;
        
        return result;
    } else {
        // if users throw a non-Error, try to send it as-is:
        return err;
    }
}

function clone(obj: any, withFunctions = true, clonedObjs = new Map()) {
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
            if (result !== undefined) {
                return result;
            }
            
            // create a new clone object:
            result = {};
            clonedObjs.set(obj, result);
            
            // first look at obj's own fields:
            for (const key in obj) {
                const value  = clone(obj[key], withFunctions, clonedObjs);
                if (withFunctions || value !== FunctionSymbol) {
                    result[key] = value;
                }
            }
            
            // then start looking at obj's prototype, if it exists and is not just the default Object proto:
            let prototype = Object.getPrototypeOf(obj);
            while (prototype != null && prototype !== Object.getPrototypeOf(result)) {
                for (const name of Object.getOwnPropertyNames(prototype)) {
                    if (!(name in result)) {
                        const value = clone(prototype[name], withFunctions, clonedObjs);
                        if (withFunctions || value !== FunctionSymbol) {
                            result[name] = value;
                        }
                    }
                }
                
                // climb up the hierarchy:
                prototype = Object.getPrototypeOf(prototype);
            }

            return result;
        }
        case 'function': 
            // functions can't be structured-cloned, so mark them with a unique identifier:
            return FunctionSymbol;
        default:
            return undefined;
    }
}

function deserializeError(err?: any) {
    if (err?._type === MessageType.Reject) {
        // this is our serialized error. Put it back in an Error instance:
        const result = new Error();
        Object.assign(result, err);
        return result;
    } else {
        return err;
    }
}
