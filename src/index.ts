import MessageHandler from './messageHandler';

/**
 * Initiate an RPC connection using the Worker postMessage and event listeners
 * @param worker {Worker} The Worker instance
 * @param host {any} An object containing methods to expose to the remote end
 */
export default function promisify<R>(worker: Worker, host?: any): {
    /** An object representing the remote end */
    remote: R;
    /** The message handler */
    handler: MessageHandler;
} {
    const handler = new MessageHandler(worker, host);
    const remote = getProxy(handler, []);
    return { remote, handler };
}

function getProxy(handler: MessageHandler, stack: Array<any>): any {
    return new Proxy(empty, {
        apply: (_target, _thisArg, args: any[]) => handler.rpc(stack, args),
        get: (_target, prop) => getProxy(handler, stack.concat(prop)),
    });
}

function empty() {}
