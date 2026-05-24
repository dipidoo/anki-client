<?php
// anki-client OAuth proxy (OCF shared-hosting PHP).
//
// Exchanges a GitHub OAuth `code` for an `access_token`. The client_secret
// stays on the server; the browser never sees it. All other GitHub API calls
// are made directly from the SPA against api.github.com (which sends proper
// CORS headers for authenticated requests).
//
// Compat: written for PHP 7.4+ (no str_contains, no enum, no readonly props).
// Deploy: see ./README.md.

// Suppress any HTML error output — we MUST return JSON only.
ini_set('display_errors', '0');
error_reporting(0);

const ALLOWED_ORIGINS = [
    'https://dipidoo.github.io',
    'http://localhost:5173', // vite dev server
];

const GITHUB_CLIENT_ID = 'Ov23liNeYzb2SRSZLynD';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

// Secret lives OUTSIDE public_html. Resolve via $HOME (set by the FPM pool),
// falling back to the user database. Relative __DIR__ traversal does NOT work
// reliably on OCF — the FPM pool's view of the filesystem differs from shell.
function resolve_secret_path() {
    $home = getenv('HOME');
    if (!$home && function_exists('posix_geteuid') && function_exists('posix_getpwuid')) {
        $info = posix_getpwuid(posix_geteuid());
        if ($info && !empty($info['dir'])) $home = $info['dir'];
    }
    if (!$home) return null;
    return $home . '/.config/anki-oauth/client_secret';
}

// ---- Headers (set BEFORE any possible error output) ---------------------

$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';
$allowOrigin = in_array($origin, ALLOWED_ORIGINS, true) ? $origin : ALLOWED_ORIGINS[0];
header("Access-Control-Allow-Origin: $allowOrigin");
header('Vary: Origin');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Access-Control-Max-Age: 86400');
header('Content-Type: application/json; charset=utf-8');

// Send-JSON helper that wins races with any latent PHP warnings.
function send_json($status, $payload) {
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

// Convert any uncaught error into a JSON 500 (keeps response parseable).
set_exception_handler(function ($e) {
    error_log('anki-oauth: uncaught: ' . $e->getMessage());
    send_json(500, ['error' => 'internal_error']);
});
register_shutdown_function(function () {
    $err = error_get_last();
    if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        error_log('anki-oauth: fatal: ' . $err['message'] . ' at ' . $err['file'] . ':' . $err['line']);
        if (!headers_sent()) {
            http_response_code(500);
            echo json_encode(['error' => 'internal_error', 'detail' => $err['message']]);
        }
    }
});

// ---- Dispatch -----------------------------------------------------------

$method = isset($_SERVER['REQUEST_METHOD']) ? $_SERVER['REQUEST_METHOD'] : 'GET';

if ($method === 'OPTIONS') {
    http_response_code(204);
    exit;
}

if ($method !== 'POST') {
    send_json(405, ['error' => 'method_not_allowed']);
}

// Parse body (accept JSON or form-urlencoded for flexibility).
$raw = file_get_contents('php://input');
$contentType = isset($_SERVER['CONTENT_TYPE']) ? $_SERVER['CONTENT_TYPE'] : '';
$body = [];
if (strpos($contentType, 'application/json') !== false) {
    $decoded = json_decode($raw, true);
    if (is_array($decoded)) $body = $decoded;
} else {
    parse_str($raw, $body);
}

$code = isset($body['code']) ? $body['code'] : '';
if (!is_string($code) || $code === '') {
    send_json(400, ['error' => 'missing_code']);
}

// ---- Load secret --------------------------------------------------------

$secretPath = resolve_secret_path();
if (!$secretPath) {
    error_log('anki-oauth: cannot resolve HOME');
    send_json(500, ['error' => 'server_misconfigured', 'detail' => 'no_home']);
}
if (!is_readable($secretPath)) {
    error_log('anki-oauth: secret not readable at ' . $secretPath);
    send_json(500, [
        'error' => 'server_misconfigured',
        'detail' => 'secret_not_readable',
        'attempted_path' => $secretPath,
    ]);
}
$clientSecret = trim((string) file_get_contents($secretPath));
if ($clientSecret === '') {
    error_log('anki-oauth: secret file empty');
    send_json(500, ['error' => 'server_misconfigured', 'detail' => 'secret_empty']);
}

// ---- Forward to GitHub --------------------------------------------------

if (!function_exists('curl_init')) {
    error_log('anki-oauth: curl extension missing');
    send_json(500, ['error' => 'server_misconfigured', 'detail' => 'no_curl']);
}

$post = http_build_query([
    'client_id'     => GITHUB_CLIENT_ID,
    'client_secret' => $clientSecret,
    'code'          => $code,
]);

$ch = curl_init(GITHUB_TOKEN_URL);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_POSTFIELDS     => $post,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HTTPHEADER     => [
        'Accept: application/json',
        'User-Agent: anki-client-oauth-proxy',
    ],
    CURLOPT_TIMEOUT        => 10,
    CURLOPT_CONNECTTIMEOUT => 5,
]);
$resp   = curl_exec($ch);
$status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$err    = curl_error($ch);
curl_close($ch);

if ($resp === false) {
    error_log('anki-oauth: curl error: ' . $err);
    send_json(502, ['error' => 'upstream_unreachable', 'detail' => $err]);
}

// GitHub already returns JSON; pass through verbatim with whatever status it returned.
http_response_code($status ?: 502);
echo $resp;
