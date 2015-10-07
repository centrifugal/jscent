var Token = require('./token');

function Config(options) {
  options = options || {};
  var url = options.url || "";

  if (url.length > 0) {
    var path = "/api";
    if (url[url.length - 1] === "/") {
      url = url.slice(0, url.length - 1);
    }
    if (url.indexOf(path, url.length - path.length) == -1) {
      url = url + path + "/";
    } else {
      url = url + "/";
    }
  }
  this.url = url;
  this.token = new Token(options.secret);
  this.timeout = options.timeout;
}

module.exports = Config;
