# Node.js library for Centrifugo HTTP API.

## Installation

You need to be running Node.js 0.8+ to use this library.

```
$ npm install jscent
```

## Usage

```javascript
var Client = require('jscent');

var client = new Client({
  url: 'http://localhost:8000',
  secret: 'SECRET_KEY'
});
```

Methods of the Client take an optional callback as the last argument. After performing the request, the callback is called with 2 arguments:

- error - if the request can't be performed or returns an error code, error will contain details, otherwise it will be null
- response - the response object

All operational errors are wrapped into a Client.RequestError object.

