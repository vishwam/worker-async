# worker-async
Provides a simple promise-based RPC interface to communicate between web workers and the host thread, instead of messing around with postMessage and event listeners:
```js
// on the worker thread:
import promisify from 'worker-async';

class RemoteClass {
    async increment(num) {
        return num + 1;
    }
}

promisify(self, RemoteClass);

// on the host thread:
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

## Bi-directional communication
worker-async allows the worker thread to call back into the host thread in the same way:
```js
// on the worker thread:
import promisify from 'worker-async';

class RemoteClass {
    constructor(host) {
        this.host = host;
    }

    async increment(num: number) {
        await this.host.log(`recieved ${num}`);
        return num + 1;
    }
}

promisify(self, RemoteClass);

// on the host thread:
import promisify from 'worker-async';

class HostClass {
    async log(str) {
        console.log(`LOG: ${str}`);
    }
}

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify(worker, HostClass);
    await remote.increment(42); // logs 42, returns 43
}
```

This can be very useful in scenarios where functionality is only available on one side of the connection (e.g., DOM manipulation, analytics tracking).


## Multiple results with Async Generators
```js
// on the worker thread:
import promisify from 'worker-async';

class RemoteClass {
    async *fetchMessages() {
        for (let i = 0; i < 10; ++i) {
            yield `msg${i}`;
        }
    }
}

promisify(self, RemoteClass);

// on the host thread:
import promisify from 'worker-async';

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify(worker);
    for await (const msg of remote.fetchMessages()) {
        console.log(msg);
    }
}

```

Async generators are automatically supported, with the same semantics as javascript (i.e., the next message is not fetched till the host asks for it.)


## Webpack
I recommend the following structure when building with webpack or next.js:
```js
// --------------------------------------------------------
// example.worker-host.js
// the host interface (executed in the host thread):
import promisify from 'worker-async';

export class HostClass {
    async log(str) {
        console.log(`LOG: ${str}`);
    }
}

// initialize the worker:
export async function initWorker() {
    // webpack's worker-loader transforms example.worker.js below, so when
    // called from the host thread, we just get a Worker constructor:
    const worker = require('./example.worker')(); // create the Worker
    const { host, remote } = await promisify(worker, HostClass);
    await remote.increment(42);
}


// --------------------------------------------------------
// example.worker-remote.js
// the remote interface (executed in the worker thread)
export class RemoteClass {
    constructor(host) {
        this.host = host;
    }

    async increment(num) {
        await this.host.log(`recieved ${num}`);
        return num + 1;
    }
}


// --------------------------------------------------------
// and finally, the entry point for the worker thread:
// example.worker.js
import { RemoteClass } from './example.worker-remote';
import promisify from 'worker-async';

promisify(self, RemoteClass); // that's it!
```


## Typings
The library is written in Typescript; you get full typings for the remote methods:
```ts
// on the worker thread:
import promisify from 'worker-async';

class RemoteClass {
    async increment(num: number) {
        return num + 1;
    }
}

promisify(self, RemoteClass);

// on the host thread:
import promisify from 'worker-async';
import { RemoteClass } from './remote';

async function initWorker() {
    const worker = new Worker(...);
    const { remote } = await promisify<RemoteClass>(worker);
    await remote.increment('abc'); // type-mismatch error
}
```


Note: although we imported RemoteClass in the host thread, it's only for typings. We're not calling it directly, so typescript removes it from the generated output: RemoteClass will _not_ be included in the host thread's bundle.


## Compatibility
The default import targets ES2017, which is supported by all evergreen browsers (Chrome, Firefox, Safari, Edge.) If you need to support IE or other old browsers, change the import to:
```js
import promisify from 'worker-async/lib/es3';
```
