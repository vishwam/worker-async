import { MessageHandler, Constructor } from './messageHandler';

/**
 * Initiate an RPC connection using the Worker postMessage and event listeners
 * @param worker {Worker} The Worker instance
 * @param ctor {Function} A class that contains the methods to expose to the other end
 */
export default async function promisify<Remote = any, Host = any>(worker: Worker, ctor?: Constructor<Remote, Host>): Promise<{
    /** Instance of the Host class */
    host: Host;
    /** An object representing the Remote class */
    remote: Remote;
}> {
    const handler = new MessageHandler(msg => worker.postMessage(msg), ctor);
    const listener = (ev: MessageEvent) => {
        if (handler.handle(ev.data)) {
            // this event was intended for us, don't propagate to other listeners:
            ev.stopImmediatePropagation();
        }
    };

    // start listening to messages:
    worker.addEventListener('message', listener);

    // send an initiate message and wait for the response:
    try {
        return await handler.sendInitiate();
    } catch (err) {
        // stop listening to messages and rethrow:
        worker.removeEventListener('message', listener);
        throw err;
    }
}
