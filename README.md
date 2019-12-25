# worker-async
Provides a simple promise-based RPC interface to communicate between web workers and the main thread, instead of messing around with postMessage and event listeners:
```js
// on the worker thread:
import promisify from 'worker-async';

class Remote {
    async increment(num) {
        return num + 1;
    }
}

promisify(self, Remote);

// on the main thread:
import promisify from 'worker-async';

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify(worker);
    await remote.increment(42); // returns 43
}
```

## Install
```sh
npm install worker-async
```

## Full-duplex communication
worker-async allows the worker thread to call the main thread in the same way:
```js
// on the worker thread:
import promisify from 'worker-async';

class Remote {
    // ctors get a reference to the other side of the connection:
    constructor(main) {
        this.main = main;
    }

    async increment(num: number) {
        await this.main.log(`received ${num}`);
        return num + 1;
    }
}

promisify(self, Remote);

// on the main thread:
import promisify from 'worker-async';

class Main {
    async log(str) {
        console.log(`LOG: ${str}`);
    }
}

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify(worker, Main); // expose Main to worker
    await remote.increment(42); // logs 42, returns 43
}
```

This can be very useful in scenarios where functionality is only available on one side of the connection (e.g., DOM manipulation, analytics tracking etc.)


## Multiple results with Async Generators
```js
// on the worker thread:
import promisify from 'worker-async';

class Remote {
    async *getItems() {
        let i = 0;
        while (true) {
            yield i++;
        }
    }
}

promisify(self, Remote);

// on the main thread:
import promisify from 'worker-async';

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify(worker);
    for await (const num of remote.getItems()) {
        console.log(num);
        if (num > 10) break;
    }
}

```

Async generators are automatically supported with the same semantics as normal javascript (i.e., the next item is not fetched till you ask for it; if you exit the loop early, the remote side will stop executing as well.)


## Webpack
See full working example with webpack/worker-loader/typescript/next.js [here](https://github.com/vishwam/worker-async-nextjs#readme). In particular, [worker-loader](https://github.com/webpack-contrib/worker-loader) requires us to create the Worker instance in a slightly different way:
```diff
async function initWorker() {
-   const worker = new Worker(...);
+   const worker = require('./example.worker')();
    const { host, remote } = await promisify(worker);
}
```


## Typings
This library is written in Typescript; you get full typings for everything, including the remote methods:
```ts
// on the worker thread:
import promisify from 'worker-async';

class Remote {
    async increment(num: number) {
        return num + 1;
    }
}

promisify(self, Remote);

// on the main thread:
import promisify from 'worker-async';
import { Remote } from './remote';

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify<Remote>(worker);
    await remote.increment('abc'); // type-mismatch error
}
```


Note: although we imported `Remote` in the main thread, it's only for typings. We're not calling it directly, so typescript removes it from the generated output: `Remote` will _not_ be included in the main thread's bundle.


## Compatibility
The default import uses ES2017 features supported by all evergreen browsers (Chrome, Firefox, Safari, Edge.) If you need to support IE or other old browsers, just change the import to:
```js
import promisify from 'worker-async/lib/es3';
```

This library does not use evals or proxies, so you don't need to worry about CSP or any other polyfills.
