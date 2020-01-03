import { MessageHandler } from './messageHandler';

/**
 * Initiate an RPC connection using the Worker postMessage and event listeners
 * @param worker {Worker} The Worker instance
 * @param host {any} An object containing methods to expose to the remote end
 * @returns Promise<any> An object representing the remote end
 */
export default async function promisify(worker: Worker, host?: any): Promise<any> {
    const handler = new MessageHandler(msg => worker.postMessage(msg), host);
    const msgListener = (ev: MessageEvent) => {
        if (handler.handle(ev.data)) {
            // this event was intended for us, don't propagate to other listeners:
            ev.stopImmediatePropagation();
        }
    };

    // start listening to messages:
    worker.addEventListener('message', msgListener);
    
    // start listening to errors:
    let errListener: any;
    const errPromise = new Promise<never>((_, reject) => {
        worker.addEventListener('error', reject); // call reject on error
        errListener = reject;
    });
    
    // send an initiate message and wait for the remote object:
    try {
        return await Promise.race([errPromise, handler.sendInitiate()]);
    } catch (err) {
        // stop listening to messages and rethrow:
        worker.removeEventListener('message', msgListener);
        throw err;
    } finally {
        worker.removeEventListener('error', errListener);
    }
}
