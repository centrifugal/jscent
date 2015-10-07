var url = require('url');
var errors = require('./errors');
var requests = require('./requests');
var Config = require('./config');
var Token = require('./token');


/** Callback passed to all HTTP API methods.
 *
 * @callback requestCallback
 * @param {RequestError} error, null if no error occurred
 * @param data – response data on commands sent
 */

/** Provides access to Centrifugo HTTP API
 *
 * @constructor
 * @param {Object} options
 * @param {String} options.url URL of Centrifugo server
 * @param {String} options.secret secret
 * @param {Integer} [options.timeout] request timeout in milliseconds
 */
function Client(options) {
  this.commands = [];
  this.config = new Config(options);
}

/** Makes a POST request to Centrifugo, handles the authentication.
 *
 * Calls back with three arguments - error, request and response. When request
 * completes with code < 400, error will be null. Otherwise, error will be
 * populated with response details.
 *
 * @param {requestCallback} [callback]
 * @see RequestError
 */
Client.prototype.send = function(callback) {
  var commands = this.commands;
  this.reset();
  requests.send(
    this.config, JSON.stringify(commands), callback
  );
};

Client.prototype._sendOne = function(callback) {

  var callbackWrapper = function(error, res) {
    if (typeof callback !== "function") {
      return;
    }
    if (error !== null) {
      callback(error, null);
    } else {
      callback(null, res[0]);
    }
  };

  this.send(callbackWrapper);
};

Client.prototype.add = function(method, params) {
  var command = {
    "method": method,
    "params": params
  };
  this.commands.push(command);
};

Client.prototype.reset = function() {
  this.commands = [];
};

Client.prototype._check = function() {
  if (this.commands.length > 0) {
    throw "command buffer not empty";
  }
};

Client.prototype.publish = function(channel, data, callback) {
  this._check();
  var params = {
    "channel": channel,
    "data": data
  };
  this.add("publish", params);
  this._sendOne(callback);
};

Client.prototype.publishClient = function(channel, data, client, callback) {
  this._check();
  var params = {
    "channel": channel,
    "data": data,
    "client": client
  };
  this.add("publish", params);
  this._sendOne(callback);
};

Client.prototype.disconnect = function(user, callback) {
  this._check();
  var params = {
    "user": user
  };
  this.add("disconnect", params);
  this._sendOne(callback);
};

Client.prototype.unsubscribe = function(user, channel, callback) {
  this._check();
  var params = {
    "channel": channel,
    "user": user
  };
  this.add("unsubscribe", params);
  this._sendOne(callback);
};

Client.prototype.presence = function(channel, callback) {
  this._check();
  var params = {
    "channel": channel
  };
  this.add("presence", params);
  this._sendOne(callback);
};

Client.prototype.history = function(channel, callback) {
  this._check();
  var params = {
    "channel": channel
  };
  this.add("history", params);
  this._sendOne(callback);
};

Client.prototype.channels = function(callback) {
  this._check();
  var params = {};
  this.add("channels", params);
  this._sendOne(callback);
};

Client.prototype.stats = function(callback) {
  this._check();
  var params = {};
  this.add("stats", params);
  this._sendOne(callback);
};

/** Exported {@link Token} constructor. */
Client.Token = Token;
/** Exported {@link RequestError} constructor. */
Client.RequestError = errors.RequestError;

module.exports = Client;
