var request = require('request');

var errors = require('./errors');

function send(config, body, callback) {
  var params = {
  	url: config.url,
  	timeout: config.timeout
  };
  if(body) {
    var sign = config.token.apiSign(body);
  	params.headers = {'content-type': 'application/json', 'X-API-Sign': sign};
  	params.body = body;
  }
  request["post"](params, function(err, res) {
    handleResponse(err, url, res, callback);
  });
}

function handleResponse(err, url, res, callback) {
  if (typeof callback !== "function") {
    return;
  }

  var error = null;
  if (err) {
    error = new errors.RequestError(
      "Request failed with an error",
      url,
      err,
      res ? res.statusCode : null,
      res ? res.body : null
    );
  } else if (res.statusCode >= 400) {
    error = new errors.RequestError(
        "Unexpected status code " + res.statusCode,
        url,
        err,
        res ? res.statusCode : null,
        res ? res.body : null
    );
  }
  if (error === null) {
    var data = JSON.parse(res.body);
    callback(null, data);
  } else {
    callback(error, null);
  }
}

exports.send = send;
