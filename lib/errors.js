/** Contains information about an HTTP request error.
 *
 * @constructor
 * @extends Error
 * @param {String} message error message
 * @param {String} url request URL
 * @param [error] optional error cause
 * @param {Integer} [statusCode] response status code, if received
 * @param {String} [body] response body, if received
 */
function RequestError(message, url, error, statusCode, body) {
    this.name = 'RequestError';
    this.stack = (new Error()).stack;

    /** @member {String} error message */
    this.message = message;
    /** @member {String} request URL */
    this.url = url;
    /** @member optional error cause */
    this.error = error;
    /** @member {Integer} response status code, if received */
    this.statusCode = statusCode;
    /** @member {String} response body, if received */
    this.body = body;
}
RequestError.prototype = new Error();

exports.RequestError = RequestError;
