'use strict';

// Render's proxy passes a client-sent X-Forwarded-For straight through (it only appends to it),
// so that header can be forged. Render sits behind Cloudflare, which overwrites cf-connecting-ip
// with the real connecting address; locally there is no proxy and the socket address is the client.
function clientIp(headers, remoteAddress) {
  const cf = (headers['cf-connecting-ip'] || '').trim();
  return cf || remoteAddress;
}

module.exports = { clientIp };
