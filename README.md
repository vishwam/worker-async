# worker-async
Provides a simple promise-based RPC interface to communicate between web workers and the main thread, instead of messing around with postMessage and event listeners:
```js
// on the worker thread:
import promisify from 'worker-async';

promisify(self, {
    async increment(num) {
        return num + 1;
    }
});

// on the main thread:
import promisify from 'worker-async';

const worker = new Worker(...);
const { remote } = promisify(worker);
await remote.increment(42); // returns 43
```

Function arguments and return values can be anything supported by the browser's [structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm). Errors thrown by the function will show up at caller with the correct message, stack, and other properties.


## Install
```sh
npm install worker-async
```

## Full-duplex communication
worker-async allows the worker thread to call the main thread in the same way:
```js
// on the worker thread:
import promisify from 'worker-async';

const { remote: main } = promisify(self, {
    async increment(num) {
        await main.log(`received ${num}`); // call `log` in the main thread
        return num + 1;
    }
});

// on the main thread:
import promisify from 'worker-async';

const worker = new Worker(...);
const { remote } = promisify(worker, {
    // expose `log` to the worker:
    async log(str) {
        console.log(`LOG: ${str}`);
    }
}); 
    
await remote.increment(42); // logs 42, returns 43
```

This can be very useful in scenarios where functionality is only available on one side of the connection (e.g., DOM manipulation, analytics tracking etc.)


## Multiple results with Async Generators
```js
// on the worker thread:
import promisify from 'worker-async';

promisify(self, {
    async *getItems() {
        let i = 0;
        while (true) {
            yield i++;
        }
    }
});

// on the main thread:
import promisify from 'worker-async';

const worker = new Worker(...);
const { remote } = promisify(worker);
for await (const num of remote.getItems()) {
    console.log(num);
    if (num > 10) break;
}
```

Async generators are automatically supported with the same semantics as normal javascript (i.e., the next item is not fetched till you ask for it; if you exit the loop early, the remote side will exit as well.)


## Webpack
See full working example with webpack/worker-loader/typescript/next.js [here](https://github.com/vishwam/worker-async-nextjs#readme). In particular, [worker-loader](https://github.com/webpack-contrib/worker-loader) requires us to create the Worker instance in a slightly different way:
```diff
-   const worker = new Worker(...);
+   const worker = require('./example.worker')();
    const { remote } = promisify(worker);
```


## Typings
This library is written in Typescript; you get full typings for everything:
```ts
// on the worker thread:
import promisify from 'worker-async';

class Remote {
    async increment(num: number) {
        return num + 1;
    }
}

promisify(self, new Remote());

// on the main thread:
import promisify from 'worker-async';
import { Remote } from './remote'; // imported only for typings
// Remote is not called directly, so it will _not_ be included in the main bundle.

const worker = new Worker(...);
const { remote } = promisify<Remote>(worker);
await remote.increment('abc'); // type-mismatch error
```


## Compatibility
The default import uses [Proxy](https://caniuse.com/#feat=proxy) and ES2017 features supported by all evergreen browsers (Chrome, Firefox, Safari, Edge.) If you need to support IE or other old browsers, you can use this alternate import that targets [ES3](https://zombiecodekill.com/2016/02/11/ecmascript-3-5-and-2015-browser-compatibility-cheat-sheet/) and doesn't use proxies:
```js
import MessageHandler from 'worker-async/lib/es3/messageHandler';

const handler = new MessageHandler(worker, host);
worker.addEventListener('message', handler.onMessage);

await handler.bind('increment')(42);
```

This library does not use evals, so you don't need to worry about [CSP](https://developer.mozilla.org/docs/Web/HTTP/Headers/Content-Security-Policy).


## Complex interfaces
The second argument (`host`) passed to `promisify` supports the following types:
* A function:
    ```js
    // on the worker thread:
    promisify(self, num => num + 1);

    // on the main thread:
    const { remote } = promisify(worker);
    await remote(42); // returns 43
    ```

* A plain object: all functions in the object and its children are exposed to the other side:
    ```js
    promisify(self, {
        increment: num => num + 1,
        http: {
            async fetch(options) { ... }
        }
    });

    // on the main thread:
    await remote.http.fetch(...);
    ```

* A class object: in addition to the object and its children, all functions in its prototype chain are also exposed:
    ```ts
    // on the main thread:
    class BaseLogger {
        async log(str: string) {
            console.log(`LOG: ${str}`);
        }
    }

    class ChildLogger extends BaseLogger {
    }

    class Main {
        logger = new ChildLogger();
    }

    promisify(worker, new Main());

    // on the worker thread:
    const { remote: main } = promisify(self);
    await main.logger.log('foo');
    ```

### Not supported
Since we have to make a remote/async call, anything that is accessed synchronously cannot be exposed to the other side, for example:
```js
class Main {
    value = 42; // primitive values are not exposed

    get foo() { } // getters/setters are synchronous, so not exposed
}
```

## Multiple promisifies
You can create multiple promisified objects on the same worker, with each host object getting its own _stream_ so the RPC calls don't conflict with each other. This is useful in scenarios where you need to control the execution state _while the remote call is running_. This is normally done by passing callback functions or event emitters, but since postMessage doesn't allow us to send complex objects or functions, we need to send over a reference (i.e., the stream ID) instead. 

The following example demonstrates this pattern by using an [AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController) to cancel a remote method:
```ts
// in the worker thread:
promisify(self, {
    async fetch(abortStream: number) {
        // we'd normally take in an AbortSignal, but since it can't be
        // sent to a worker, we create a new AbortController here and 
        // expose it to the main thread at a predetermined stream:
        const ctrl = new AbortController();
        const { handler } = promisify(self, ctrl);
        handler.stream = abortStream;
        try {
            // wait for host thread to abort:
            await new Promise(r => setTimeout(r, 1000));
            
            return ctrl.signal.aborted;
        } finally {
            // stop listening to messages in this stream. REQUIRED:
            // you'll have a memory leak in the worker otherwise.
            handler.stop();
        }
    }
})

// in the main thread:
const worker = new Worker(...);
const { remote } = promisify(worker);

fetch() {
    // create a promisified remote AbortController and have it talk on 
    // a separate stream so it doesn't conflict with `remote`:
    const { remote: ctrl, handler } = promisify<AbortController>(worker);
    try {
        const abortStream = handler.stream = Math.random(); // can be any number/stream
        const promise = remote.fetch(abortStream);

        // while fetch is executing, abort the remote controller:
        ctrl.abort();

        console.log('isAborted? ', await promise); // logs `true`
    } finally {
        // stop listening to messages in this stream. REQUIRED:
        // you'll have a memory leak in the worker otherwise.
        handler.stop();
    }
}

// in the real world, we'd probably tie in the remote controller
// with an already existing AbortSignal:
signal.addEventListener('abort', () => ctrl.abort());
```
