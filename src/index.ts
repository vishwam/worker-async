import MessageHandler from './messageHandler';

/**
 * Initiate an RPC connection using the Worker postMessage and event listeners
 * @param worker {Worker} The Worker instance
 * @param host {any} An object containing methods to expose to the remote end
 * @returns Promise<any> An object representing the remote end
 */
export default function promisify(worker: Worker, host?: any): any {
    const handler = new MessageHandler(worker, host);
    worker.addEventListener('message', handler.onMessage);
    return getProxy(handler, []);
}

function getProxy(handler: MessageHandler, stack: Array<any>): any {
    return new Proxy(empty, {
        apply: (_target, _thisArg, args: any[]) => handler.rpc(stack, args),
        get: (_target, prop) => getProxy(handler, stack.concat(prop)),
    });
}

function empty() {}
