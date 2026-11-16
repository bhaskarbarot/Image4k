/* HTTP status code reference. Official codes follow the IANA "HTTP Status Code Registry"
 * (RFC 9110 and the RFCs cited per code). Non-standard codes used by popular software are included
 * but clearly marked `status: 'unofficial'`. `cacheable` = heuristically cacheable by default (RFC 9110 §15.1). */

export const CLASSES = {
  1: { name: 'Informational', desc: 'The request was received; the process continues (interim response).' },
  2: { name: 'Success', desc: 'The request was successfully received, understood and accepted.' },
  3: { name: 'Redirection', desc: 'Further action is needed to complete the request.' },
  4: { name: 'Client error', desc: 'The request contains bad syntax or cannot be fulfilled — the client should change something.' },
  5: { name: 'Server error', desc: 'The server failed to fulfil an apparently valid request.' },
};

// [code, name, ref, meaning, uses[], troubleshooting[], extra?]
const R = [
  [100, 'Continue', 'RFC 9110 §15.2.1', 'The initial part of the request was received and the client should continue sending the body (reply to "Expect: 100-continue").', ['Large uploads where the client first checks the server will accept the body'], ['Clients normally handle this automatically; if uploads stall, check that the server or proxy supports Expect: 100-continue, or remove that header.']],
  [101, 'Switching Protocols', 'RFC 9110 §15.2.2', 'The server agrees to switch protocols as requested in the Upgrade header.', ['WebSocket handshakes (Upgrade: websocket)', 'Upgrading HTTP/1.1 to h2c'], ['If a WebSocket fails to connect, check that every proxy/load balancer forwards the Upgrade and Connection headers.']],
  [102, 'Processing', 'RFC 2518 (WebDAV)', 'WebDAV interim response: the server has accepted the request but has not finished it yet. Deprecated in later WebDAV specs and rarely sent.', ['Long-running WebDAV operations'], ['Usually safe to ignore; wait for the final response.']],
  [103, 'Early Hints', 'RFC 8297', 'Interim response carrying Link headers so the browser can start preloading resources while the server prepares the final response.', ['Preloading CSS/JS/fonts before the HTML is ready'], ['Only useful with Link: rel=preload/preconnect headers; check your CDN supports forwarding 103.']],
  [104, 'Upload Resumption Supported', 'IANA (temporary registration, draft-ietf-httpbis-resumable-upload)', 'Interim response telling the client that an upload can be resumed if it is interrupted. Temporary registration for a draft standard.', ['Resumable uploads (draft)'], ['Experimental — most clients ignore it.']],

  [200, 'OK', 'RFC 9110 §15.3.1', 'The request succeeded. The body depends on the method (e.g. the resource for GET, the result of the action for POST).', ['Successful GET', 'Successful POST/PUT that returns a body'], ['If the body is empty or unexpected, check content negotiation (Accept header) and that the right endpoint was called.'], { cacheable: true }],
  [201, 'Created', 'RFC 9110 §15.3.2', 'The request succeeded and one or more new resources were created, typically identified by the Location header.', ['POST that creates a record', 'PUT that creates a new resource'], ['Look at the Location header for the new resource URL.']],
  [202, 'Accepted', 'RFC 9110 §15.3.3', 'The request was accepted for processing, but processing is not finished (and may still fail).', ['Asynchronous jobs, queues, batch imports'], ['Poll the status URL the API returns (often in Location or the body) to see the final result.']],
  [203, 'Non-Authoritative Information', 'RFC 9110 §15.3.4', 'Success, but the content was modified by a transforming proxy relative to the origin\'s 200 response.', ['Proxies that rewrite responses'], ['If content looks altered, check intermediate proxies.'], { cacheable: true }],
  [204, 'No Content', 'RFC 9110 §15.3.5', 'The request succeeded and there is intentionally no response body.', ['DELETE success', 'PUT/PATCH that returns nothing', 'CORS preflight replies'], ['Do not try to parse a body — JSON parsers will fail on the empty response.'], { cacheable: true }],
  [205, 'Reset Content', 'RFC 9110 §15.3.6', 'Success; the client should reset the document view (e.g. clear a form). No body.', ['Form submissions that should clear the form'], ['Rarely used; treat like 204.']],
  [206, 'Partial Content', 'RFC 9110 §15.3.7', 'The server is delivering only part of the resource, as requested by a Range header.', ['Resumable downloads', 'Video/audio seeking'], ['Check the Content-Range header; if you wanted the full file, remove the Range header.'], { cacheable: true }],
  [207, 'Multi-Status', 'RFC 4918 (WebDAV)', 'The body (XML) contains separate status codes for multiple independent operations.', ['WebDAV PROPFIND, batch operations'], ['Read each <status> in the body — some operations may have failed even though the overall code is 2xx.']],
  [208, 'Already Reported', 'RFC 5842 (WebDAV)', 'Members of a WebDAV binding were already listed earlier in the same multi-status response.', ['WebDAV bindings with loops'], ['Only relevant inside 207 responses.']],
  [226, 'IM Used', 'RFC 3229', 'The server applied instance-manipulations (e.g. delta encoding) to the current instance of the resource.', ['Delta encoding of feeds'], ['Rare; make sure your client understands the A-IM/IM headers it sent.']],

  [300, 'Multiple Choices', 'RFC 9110 §15.4.1', 'The resource has several representations; the client (or user) should choose one.', ['Content negotiation with several options'], ['Rare in APIs; follow the preferred link in Location if present.'], { cacheable: true }],
  [301, 'Moved Permanently', 'RFC 9110 §15.4.2', 'The resource has a new permanent URL (in Location). Clients may change POST to GET when following it.', ['Domain or URL structure changes', 'HTTP → HTTPS redirects'], ['Update links/bookmarks to the new URL. Use 308 if the method and body must be kept. Browsers cache 301s aggressively.'], { cacheable: true }],
  [302, 'Found', 'RFC 9110 §15.4.3', 'The resource is temporarily at another URL (Location). Historically clients change POST to GET.', ['Temporary redirects, login redirects'], ['Use 307 if the method must not change. With curl add -L to follow redirects.']],
  [303, 'See Other', 'RFC 9110 §15.4.4', 'The response is at another URL, which should be fetched with GET.', ['Post/Redirect/Get pattern after form submissions'], ['Expected after POST; the client should GET the Location URL.']],
  [304, 'Not Modified', 'RFC 9110 §15.4.5', 'The cached version is still valid (conditional request with If-None-Match / If-Modified-Since). No body.', ['Browser and CDN cache revalidation'], ['Normal behaviour. If you see stale data, check ETag/Last-Modified generation on the server.']],
  [305, 'Use Proxy', 'RFC 9110 §15.4.6', 'Deprecated: the resource had to be accessed through a proxy. Clients must not honour it for security reasons.', ['(Deprecated — do not use)'], ['Ignore; reconfigure the server.'], { status: 'deprecated' }],
  [306, '(Unused)', 'RFC 9110 §15.4.7', 'Reserved; was "Switch Proxy" in an old draft. Must not be used.', [], [], { status: 'unused' }],
  [307, 'Temporary Redirect', 'RFC 9110 §15.4.8', 'Temporary redirect to Location; the client must repeat the same method and body.', ['Temporary moves of API endpoints', 'HSTS internal redirects in browsers'], ['Make sure the client resends the body; with curl use -L.']],
  [308, 'Permanent Redirect', 'RFC 9110 §15.4.9', 'Permanent redirect to Location; the client must repeat the same method and body.', ['Permanent API moves where POST must stay POST'], ['Update the stored URL. Very old clients may not support 308.'], { cacheable: true }],

  [400, 'Bad Request', 'RFC 9110 §15.5.1', 'The server cannot process the request because of a client error (malformed syntax, invalid framing, bad parameters…).', ['Invalid JSON body', 'Missing or invalid parameters'], ['Validate the body (e.g. with the JSON Formatter), check Content-Type matches the body, and read the error details in the response body.']],
  [401, 'Unauthorized', 'RFC 9110 §15.5.2', 'Authentication is missing or invalid. The response must include a WWW-Authenticate header describing how to authenticate.', ['Missing/expired token', 'Wrong API key'], ['Send the Authorization header (e.g. Bearer token), refresh expired tokens (check "exp" with the JWT Decoder), and make sure proxies don\'t strip the header.']],
  [402, 'Payment Required', 'RFC 9110 §15.5.3', 'Reserved for future use; some APIs use it for billing/quota problems.', ['Paid API plan exhausted (non-standard usage)'], ['Check the account\'s billing or plan status.']],
  [403, 'Forbidden', 'RFC 9110 §15.5.4', 'The server understood the request but refuses to fulfil it; re-authenticating will not help.', ['Insufficient permissions/scopes', 'IP blocked', 'WAF block'], ['Check the user\'s roles/scopes, file permissions, IP allow-lists and WAF/firewall rules.']],
  [404, 'Not Found', 'RFC 9110 §15.5.5', 'The server has no current representation for the target resource (or does not want to reveal it exists).', ['Wrong URL', 'Deleted record', 'Hidden resource'], ['Check the path, IDs, base URL and API version; check routing and trailing slashes.'], { cacheable: true }],
  [405, 'Method Not Allowed', 'RFC 9110 §15.5.6', 'The method is not supported for this resource. The Allow header lists the supported methods.', ['POST to a read-only endpoint'], ['Use a method from the Allow header; check you are not hitting a static file server.'], { cacheable: true }],
  [406, 'Not Acceptable', 'RFC 9110 §15.5.7', 'The server cannot produce a response matching the Accept* headers.', ['Requesting application/xml from a JSON-only API'], ['Relax or remove the Accept header.']],
  [407, 'Proxy Authentication Required', 'RFC 9110 §15.5.8', 'Like 401, but the client must authenticate with a proxy (Proxy-Authenticate header).', ['Corporate proxies'], ['Configure proxy credentials (curl: --proxy-user).']],
  [408, 'Request Timeout', 'RFC 9110 §15.5.9', 'The server did not receive a complete request in the time it was prepared to wait.', ['Slow uploads', 'Idle keep-alive connections'], ['Retry; check network speed and client upload timeouts.']],
  [409, 'Conflict', 'RFC 9110 §15.5.10', 'The request conflicts with the current state of the resource.', ['Duplicate unique key', 'Edit conflict / version mismatch'], ['Fetch the latest version, merge the changes and retry; check unique constraints.']],
  [410, 'Gone', 'RFC 9110 §15.5.11', 'The resource is permanently gone and no forwarding address is known.', ['Retired API versions', 'Deleted content'], ['Remove links to it; migrate to the replacement API.'], { cacheable: true }],
  [411, 'Length Required', 'RFC 9110 §15.5.12', 'The server requires a Content-Length header.', ['Servers that refuse chunked uploads'], ['Send Content-Length (avoid chunked transfer encoding).']],
  [412, 'Precondition Failed', 'RFC 9110 §15.5.13', 'A condition in the request headers (If-Match, If-Unmodified-Since…) evaluated to false.', ['Optimistic concurrency with ETags'], ['Re-fetch to get the current ETag and retry.']],
  [413, 'Content Too Large', 'RFC 9110 §15.5.14', 'The request body is larger than the server is willing to process (formerly "Payload Too Large").', ['File uploads above the limit'], ['Reduce the size or raise the limit (e.g. nginx client_max_body_size).']],
  [414, 'URI Too Long', 'RFC 9110 §15.5.15', 'The request target (URL) is longer than the server will interpret.', ['Huge query strings', 'Redirect loops that append to the URL'], ['Move data from the query string into a POST body.'], { cacheable: true }],
  [415, 'Unsupported Media Type', 'RFC 9110 §15.5.16', 'The body\'s format (Content-Type or Content-Encoding) is not supported.', ['Sending form data to a JSON endpoint'], ['Set the correct Content-Type (e.g. application/json) and make sure the body matches it.']],
  [416, 'Range Not Satisfiable', 'RFC 9110 §15.5.17', 'None of the ranges in the Range header can be satisfied (e.g. beyond the end of the file).', ['Resuming a download of a file that changed size'], ['Restart the download without a Range header.']],
  [417, 'Expectation Failed', 'RFC 9110 §15.5.18', 'The Expect header could not be met.', ['Servers that do not support Expect: 100-continue'], ['Remove the Expect header (curl: -H "Expect:").']],
  [418, '(Unused) — "I\'m a teapot"', 'RFC 9110 §15.5.19 (from RFC 2324)', 'Reserved. Originally an April Fools\' joke in RFC 2324; RFC 9110 marks the code as unused but reserved because it is widely implemented as an easter egg.', ['Easter eggs, some bot-blocking responses'], ['Not a real error class — the server is deliberately refusing (often anti-bot).'], { status: 'unused' }],
  [421, 'Misdirected Request', 'RFC 9110 §15.5.20', 'The request was sent to a server that cannot produce a response for this scheme/authority (e.g. reused HTTP/2 connection for another host).', ['HTTP/2 connection coalescing with mismatched certificates'], ['Retry on a new connection; check TLS certificate / SNI configuration.']],
  [422, 'Unprocessable Content', 'RFC 9110 §15.5.21', 'The syntax is correct, but the server cannot process the contained instructions (validation errors).', ['Form/JSON validation errors (Rails, Laravel, FastAPI…)'], ['Read the validation messages in the body and fix the field values.']],
  [423, 'Locked', 'RFC 4918 (WebDAV)', 'The resource is locked.', ['WebDAV locks'], ['Wait for the lock to be released or unlock it.']],
  [424, 'Failed Dependency', 'RFC 4918 (WebDAV)', 'The request failed because it depended on another request that failed.', ['WebDAV batch operations'], ['Fix the operation that failed first.']],
  [425, 'Too Early', 'RFC 8470', 'The server is unwilling to process a request that might be replayed (TLS 1.3 early data).', ['0-RTT requests'], ['Retry after the TLS handshake completes (clients usually do this automatically).']],
  [426, 'Upgrade Required', 'RFC 9110 §15.5.22', 'The server refuses the request with the current protocol; the Upgrade header says which protocol is required.', ['Endpoints that require TLS or HTTP/2', 'WebSocket endpoints hit with plain HTTP'], ['Use the protocol named in the Upgrade header.']],
  [428, 'Precondition Required', 'RFC 6585', 'The server requires the request to be conditional (If-Match) to avoid lost updates.', ['APIs enforcing optimistic locking'], ['GET the resource, then send its ETag in If-Match.']],
  [429, 'Too Many Requests', 'RFC 6585', 'The client sent too many requests in a given time (rate limiting).', ['API rate limits', 'Login brute-force protection'], ['Respect Retry-After, add exponential backoff, cache results, and check X-RateLimit-* headers.']],
  [431, 'Request Header Fields Too Large', 'RFC 6585', 'One header, or all headers together, are too large.', ['Huge cookies', 'Very large JWTs'], ['Clear cookies for the site, shrink tokens, or raise the server header-size limit.']],
  [451, 'Unavailable For Legal Reasons', 'RFC 7725', 'The resource is unavailable because of a legal demand (e.g. censorship, court order).', ['Geo-blocked or legally removed content'], ['Nothing to fix client-side; the Link header may name the blocking authority.']],

  [500, 'Internal Server Error', 'RFC 9110 §15.6.1', 'The server hit an unexpected condition.', ['Unhandled exceptions', 'Bugs, misconfiguration'], ['Check the server logs/stack trace; if it is not your server, retry later and report it with the request ID.']],
  [501, 'Not Implemented', 'RFC 9110 §15.6.2', 'The server does not support the functionality (often the HTTP method) required.', ['Unknown HTTP method'], ['Use a supported method.'], { cacheable: true }],
  [502, 'Bad Gateway', 'RFC 9110 §15.6.3', 'A gateway/proxy received an invalid response from the upstream server.', ['App server crashed behind nginx/a load balancer', 'Upstream returned garbage'], ['Check that the upstream app is running and listening on the expected port; check proxy logs.']],
  [503, 'Service Unavailable', 'RFC 9110 §15.6.4', 'The server is temporarily unable to handle the request (overload or maintenance). May include Retry-After.', ['Maintenance mode', 'Overload', 'No healthy backends'], ['Retry after the Retry-After delay; scale up or check health checks.']],
  [504, 'Gateway Timeout', 'RFC 9110 §15.6.5', 'A gateway/proxy did not get a timely response from the upstream server.', ['Slow database queries', 'Long-running requests behind a proxy'], ['Speed up the upstream work, make it asynchronous (202), or raise the proxy timeout.']],
  [505, 'HTTP Version Not Supported', 'RFC 9110 §15.6.6', 'The server does not support the HTTP version used in the request.', ['Very old or very new protocol versions'], ['Use HTTP/1.1 (curl: --http1.1).']],
  [506, 'Variant Also Negotiates', 'RFC 2295', 'Server configuration error in transparent content negotiation: the chosen variant is itself negotiable.', ['Misconfigured content negotiation'], ['Server-side configuration fix.']],
  [507, 'Insufficient Storage', 'RFC 4918 (WebDAV)', 'The server cannot store the representation needed to complete the request.', ['Disk full', 'Quota exceeded'], ['Free disk space or raise the quota.']],
  [508, 'Loop Detected', 'RFC 5842 (WebDAV)', 'The server found an infinite loop while processing the request.', ['WebDAV binding loops'], ['Fix the circular binding/redirect on the server.']],
  [510, 'Not Extended (OBSOLETED)', 'RFC 2774 (historic)', 'Further extensions to the request are required. RFC 2774 has been moved to Historic status.', ['(Obsolete)'], ['Not used by modern servers.'], { status: 'deprecated' }],
  [511, 'Network Authentication Required', 'RFC 6585', 'The client must authenticate to gain network access (captive portals).', ['Hotel / airport Wi-Fi login pages'], ['Open a browser and log in to the network portal.']],

  // ---- unofficial, but commonly seen ----
  [419, 'Page Expired', 'Laravel (unofficial)', 'Laravel: the CSRF token is missing or expired.', ['Form submitted after the session expired'], ['Reload the page to get a new CSRF token; include X-CSRF-TOKEN in AJAX calls.'], { status: 'unofficial' }],
  [420, 'Enhance Your Calm', 'Twitter API v1 (unofficial)', 'Old Twitter API rate-limit response (now 429).', ['Legacy Twitter clients'], ['Treat like 429.'], { status: 'unofficial' }],
  [444, 'No Response', 'nginx (unofficial)', 'nginx closes the connection without sending a response (used in config to drop bad requests). Appears only in nginx logs.', ['Dropping malicious requests'], ['Check nginx "return 444" rules.'], { status: 'unofficial' }],
  [494, 'Request Header Too Large', 'nginx (unofficial)', 'nginx: request headers are too large (logged before returning 400).', ['Large cookies'], ['Raise large_client_header_buffers or shrink headers.'], { status: 'unofficial' }],
  [495, 'SSL Certificate Error', 'nginx (unofficial)', 'nginx: the client certificate is invalid.', ['Mutual TLS'], ['Check the client certificate chain.'], { status: 'unofficial' }],
  [496, 'SSL Certificate Required', 'nginx (unofficial)', 'nginx: a client certificate was required but not provided.', ['Mutual TLS'], ['Send a client certificate (curl: --cert).'], { status: 'unofficial' }],
  [497, 'HTTP Request Sent to HTTPS Port', 'nginx (unofficial)', 'nginx: plain HTTP was sent to an HTTPS port.', ['Wrong scheme'], ['Use https://.'], { status: 'unofficial' }],
  [499, 'Client Closed Request', 'nginx (unofficial)', 'nginx: the client closed the connection before the server answered. Only appears in logs.', ['User navigated away', 'Client timeout shorter than server processing time'], ['Speed up the endpoint or raise the client timeout.'], { status: 'unofficial' }],
  [509, 'Bandwidth Limit Exceeded', 'cPanel/Apache (unofficial)', 'Hosting account exceeded its bandwidth allowance.', ['Shared hosting'], ['Upgrade the plan or wait for the quota reset.'], { status: 'unofficial' }],
  [520, 'Web Server Returned an Unknown Error', 'Cloudflare (unofficial)', 'Cloudflare: the origin returned an empty, unknown or unexpected response.', ['Origin crashes, oversized headers'], ['Check origin logs; make sure headers are < 32 KB and the origin returns valid HTTP.'], { status: 'unofficial' }],
  [521, 'Web Server Is Down', 'Cloudflare (unofficial)', 'Cloudflare: the origin refused the connection.', ['Origin offline, firewall blocking Cloudflare IPs'], ['Start the web server; allow Cloudflare IP ranges in the firewall.'], { status: 'unofficial' }],
  [522, 'Connection Timed Out', 'Cloudflare (unofficial)', 'Cloudflare: the TCP connection to the origin timed out.', ['Origin overloaded or unreachable'], ['Check origin load, routing and firewall.'], { status: 'unofficial' }],
  [523, 'Origin Is Unreachable', 'Cloudflare (unofficial)', 'Cloudflare could not reach the origin (DNS or routing problem).', ['Wrong DNS records'], ['Check the origin IP in the DNS settings.'], { status: 'unofficial' }],
  [524, 'A Timeout Occurred', 'Cloudflare (unofficial)', 'Cloudflare connected but the origin did not send an HTTP response within the timeout (100 s by default).', ['Long-running requests'], ['Make the work asynchronous or faster.'], { status: 'unofficial' }],
  [525, 'SSL Handshake Failed', 'Cloudflare (unofficial)', 'Cloudflare could not complete the TLS handshake with the origin.', ['Origin TLS misconfiguration'], ['Check the origin certificate and supported ciphers / SNI.'], { status: 'unofficial' }],
  [526, 'Invalid SSL Certificate', 'Cloudflare (unofficial)', 'Cloudflare could not validate the origin certificate (Full strict mode).', ['Expired or self-signed origin certificate'], ['Install a valid certificate (or a Cloudflare Origin CA certificate).'], { status: 'unofficial' }],
  [530, 'Origin DNS / Frozen', 'Cloudflare / Pantheon (unofficial)', 'Cloudflare returns 530 together with a 1xxx error (often 1016 origin DNS error).', ['DNS errors at the origin'], ['Look up the accompanying 1xxx error code.'], { status: 'unofficial' }],
];

export const STATUS_CODES = R.map(([code, name, ref, meaning, uses, fix, extra = {}]) => ({
  code, name, ref, meaning, uses, fix,
  cls: Math.floor(code / 100),
  status: extra.status || 'official',
  cacheable: !!extra.cacheable,
})).sort((a, b) => a.code - b.code);

export const byCode = (c) => STATUS_CODES.find((s) => s.code === Number(c));

/** search(query, cls) → matching entries. query matches code prefix, name or text. cls = 1..5 or null. */
export function searchStatus(query, cls) {
  const q = String(query || '').trim().toLowerCase();
  return STATUS_CODES.filter((s) => {
    if (cls && s.cls !== Number(cls)) return false;
    if (!q) return true;
    if (/^\d{1,3}$/.test(q)) return String(s.code).startsWith(q);
    if (/^[1-5]xx$/.test(q)) return s.cls === Number(q[0]);
    return [s.code, s.name, s.meaning, s.ref, ...s.uses, ...s.fix].join(' ').toLowerCase().includes(q);
  });
}
